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
	private readonly ConcurrentDictionary<string, string> _folderToSession =
		new(StringComparer.Ordinal);
	private readonly TimeProvider _timeProvider;
	private CancellationTokenSource? _sweeperCts;
	private Task? _sweeperTask;
	private bool _shutdown;

	public VSCodeSessionManager(
		IServiceProvider services,
		ILogger<VSCodeSessionManager> logger,
		ILoggerFactory loggerFactory,
		IOptions<OpenVSCodeServerOptions> options)
		: this(services, logger, loggerFactory, options, TimeProvider.System)
	{
	}

	internal VSCodeSessionManager(
		IServiceProvider services,
		ILogger<VSCodeSessionManager> logger,
		ILoggerFactory loggerFactory,
		IOptions<OpenVSCodeServerOptions> options,
		TimeProvider timeProvider)
	{
		_services = services;
		_logger = logger;
		_loggerFactory = loggerFactory;
		_options = options.Value;
		_timeProvider = timeProvider;
	}

	public Task StartAsync(CancellationToken cancellationToken)
	{
		if (_options.Sessions.CleanOrphansOnStartup)
		{
			CleanOrphans();
		}

		if (_options.Sessions.IdleTimeout > TimeSpan.Zero)
		{
			_sweeperCts = new CancellationTokenSource();
			_sweeperTask = Task.Run(() => SweepLoopAsync(_sweeperCts.Token));
		}

		return Task.CompletedTask;
	}

	public async Task StopAsync(CancellationToken cancellationToken)
	{
		_shutdown = true;
		await StopSweeperAsync().ConfigureAwait(false);
		await DisposeAllAsync().ConfigureAwait(false);
	}

	public async ValueTask DisposeAsync()
	{
		_shutdown = true;
		await StopSweeperAsync().ConfigureAwait(false);
		await DisposeAllAsync().ConfigureAwait(false);
	}

	private async Task StopSweeperAsync()
	{
		CancellationTokenSource? cts;
		Task? task;
		lock (_sessions)
		{
			cts = _sweeperCts;
			task = _sweeperTask;
			_sweeperCts = null;
			_sweeperTask = null;
		}

		if (cts is null)
		{
			return;
		}

		try { cts.Cancel(); }
		catch (ObjectDisposedException) { /* already disposed */ }

		if (task is not null)
		{
			try { await task.ConfigureAwait(false); } catch { /* logged inside */ }
		}

		cts.Dispose();
	}

	private async Task DisposeAllAsync()
	{
		var sessions = _sessions.Values.ToList();
		_sessions.Clear();
		_folderToSession.Clear();
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

		_folderToSession.TryAdd(NormalizeFolder(folder), sessionId);
		return session;
	}

	public VSCodeSession? Get(string sessionId)
	{
		return _sessions.TryGetValue(sessionId, out var session) ? session : null;
	}

	/// <summary>
	/// Looks up the session that owns the supplied workspace folder path and bumps its
	/// last-seen timestamp. Returns true if a matching session was found. Used by the proxy to
	/// keep sessions alive while the user is actively editing.
	/// </summary>
	public bool TouchByWorkspaceFolder(string workspaceFolder)
	{
		if (string.IsNullOrEmpty(workspaceFolder))
		{
			return false;
		}

		if (!_folderToSession.TryGetValue(NormalizeFolder(workspaceFolder), out var sessionId))
		{
			return false;
		}

		if (!_sessions.TryGetValue(sessionId, out var session))
		{
			return false;
		}

		session.Touch();
		return true;
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

		_folderToSession.TryRemove(NormalizeFolder(session.WorkspaceFolder), out _);
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

	private void CleanOrphans()
	{
		string root;
		try
		{
			root = ResolveRoot();
		}
		catch (Exception ex)
		{
			_logger.LogWarning(ex, "Could not resolve session root directory for orphan cleanup.");
			return;
		}

		int removed = 0;
		foreach (var dir in Directory.EnumerateDirectories(root))
		{
			try
			{
				Directory.Delete(dir, recursive: true);
				removed++;
			}
			catch (Exception ex)
			{
				_logger.LogWarning(ex,
					"Failed to remove orphan session folder {Folder}; it will be left on disk.", dir);
			}
		}

		if (removed > 0)
		{
			_logger.LogInformation("Cleaned up {Count} orphan session folder(s) in {Root}.", removed, root);
		}
	}

	private async Task SweepLoopAsync(CancellationToken cancellationToken)
	{
		var idleTimeout = _options.Sessions.IdleTimeout;
		var interval = _options.Sessions.IdleSweepInterval;
		if (interval <= TimeSpan.Zero || interval > idleTimeout)
		{
			interval = idleTimeout;
		}

		try
		{
			while (!cancellationToken.IsCancellationRequested)
			{
				try
				{
					await Task.Delay(interval, _timeProvider, cancellationToken).ConfigureAwait(false);
				}
				catch (OperationCanceledException)
				{
					return;
				}

				await EvictIdleAsync(idleTimeout, cancellationToken).ConfigureAwait(false);
			}
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Idle-session sweeper terminated unexpectedly.");
		}
	}

	internal async Task EvictIdleAsync(TimeSpan idleTimeout, CancellationToken cancellationToken)
	{
		if (idleTimeout <= TimeSpan.Zero)
		{
			return;
		}

		var now = _timeProvider.GetUtcNow().UtcDateTime;
		List<VSCodeSession>? expired = null;
		foreach (var session in _sessions.Values)
		{
			if (now - session.LastSeenUtc >= idleTimeout)
			{
				(expired ??= new List<VSCodeSession>()).Add(session);
			}
		}

		if (expired is null)
		{
			return;
		}

		foreach (var session in expired)
		{
			try
			{
				_logger.LogInformation(
					"Evicting idle session {SessionId} (last seen {LastSeenUtc:o}).",
					session.SessionId, session.LastSeenUtc);
				await EndAsync(session.SessionId, cancellationToken).ConfigureAwait(false);
			}
			catch (Exception ex)
			{
				_logger.LogError(ex, "Failed to evict idle session {SessionId}.", session.SessionId);
			}
		}
	}

	private static string NormalizeFolder(string folder)
	{
		// Compare workspace folder paths case-insensitively on Windows (filesystem semantics) and
		// case-sensitively elsewhere. Trim trailing separators so `/tmp/foo` and `/tmp/foo/` map
		// to the same key.
		var trimmed = folder.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
		return OperatingSystem.IsWindows() ? trimmed.ToLowerInvariant() : trimmed;
	}

	private static string NewSessionId()
	{
		// 128 random bits, URL-safe base64. ~22 chars.
		var bytes = RandomNumberGenerator.GetBytes(16);
		return Convert.ToBase64String(bytes)
			.Replace('+', '-').Replace('/', '_').TrimEnd('=');
	}
}
