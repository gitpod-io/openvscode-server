// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Tracks the set of live VS Code sessions, brokers calls into <see cref="IVSCodeFiles"/>, and
/// ensures temp folders are flushed and removed on host shutdown.
/// </summary>
internal sealed class VSCodeSessionManager : IHostedService, IAsyncDisposable
{
	private readonly IServiceProvider _services;
	private readonly ILogger<VSCodeSessionManager> _logger;
	private readonly ILoggerFactory _loggerFactory;
	private readonly OpenVSCodeServerOptions _options;
	private readonly ConcurrentDictionary<string, VSCodeSession> _sessions = new(StringComparer.Ordinal);
	private bool _shutdown;

	public VSCodeSessionManager(
		IServiceProvider services,
		ILogger<VSCodeSessionManager> logger,
		ILoggerFactory loggerFactory,
		IOptions<OpenVSCodeServerOptions> options)
	{
		_services = services;
		_logger = logger;
		_loggerFactory = loggerFactory;
		_options = options.Value;
	}

	public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

	public async Task StopAsync(CancellationToken cancellationToken)
	{
		_shutdown = true;
		await DisposeAllAsync().ConfigureAwait(false);
	}

	public async ValueTask DisposeAsync()
	{
		_shutdown = true;
		await DisposeAllAsync().ConfigureAwait(false);
	}

	private async Task DisposeAllAsync()
	{
		var sessions = _sessions.Values.ToList();
		_sessions.Clear();
		foreach (var session in sessions)
		{
			try
			{
				await session.DisposeAsync().ConfigureAwait(false);
			}
			catch (Exception ex)
			{
				_logger.LogError(ex, "Failed to dispose session {SessionId} during shutdown.", session.SessionId);
			}
		}
	}

	/// <summary>
	/// Creates a fresh session, runs the consumer's <see cref="IVSCodeFiles.InitializeAsync"/>,
	/// and arms the file watcher. Throws if shutdown is already in progress.
	/// </summary>
	public async Task<VSCodeSession> CreateAsync(
		IReadOnlyDictionary<string, string>? state,
		CancellationToken cancellationToken)
	{
		if (_shutdown)
		{
			throw new InvalidOperationException("The session manager is shutting down; no new sessions can be created.");
		}

		var sessionId = NewSessionId();
		var folder = Path.Combine(ResolveRoot(), sessionId);
		Directory.CreateDirectory(folder);

		var session = new VSCodeSession(
			sessionId,
			folder,
			state ?? new Dictionary<string, string>(StringComparer.Ordinal),
			_services,
			_loggerFactory.CreateLogger<VSCodeSession>(),
			_options.Sessions.SaveDebounce);

		try
		{
			await session.InitializeAsync(cancellationToken).ConfigureAwait(false);
		}
		catch
		{
			await session.DisposeAsync().ConfigureAwait(false);
			throw;
		}

		session.StartWatching();

		if (!_sessions.TryAdd(sessionId, session))
		{
			// Astronomically unlikely with 128-bit ids; bail loudly rather than silently leak.
			await session.DisposeAsync().ConfigureAwait(false);
			throw new InvalidOperationException($"Session id collision: {sessionId}");
		}

		return session;
	}

	public VSCodeSession? Get(string sessionId)
	{
		return _sessions.TryGetValue(sessionId, out var session) ? session : null;
	}

	/// <summary>
	/// Flushes pending changes, runs a final <see cref="IVSCodeFiles.SaveAsync"/>, removes the
	/// temp folder, and forgets the session. Returns false if no session with that id exists.
	/// </summary>
	public async Task<bool> EndAsync(string sessionId, CancellationToken cancellationToken)
	{
		if (!_sessions.TryRemove(sessionId, out var session))
		{
			return false;
		}

		await session.DisposeAsync().ConfigureAwait(false);
		return true;
	}

	private string ResolveRoot()
	{
		var configured = _options.Sessions.RootDirectory;
		var root = string.IsNullOrEmpty(configured)
			? Path.Combine(Path.GetTempPath(), "openvscode-sessions")
			: configured;
		Directory.CreateDirectory(root);
		return root;
	}

	private static string NewSessionId()
	{
		// 128 random bits, URL-safe base64. ~22 chars.
		var bytes = RandomNumberGenerator.GetBytes(16);
		return Convert.ToBase64String(bytes)
			.Replace('+', '-').Replace('/', '_').TrimEnd('=');
	}
}
