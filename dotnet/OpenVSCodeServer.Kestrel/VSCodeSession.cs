// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// In-process representation of a single VS Code session: owns the temporary workspace folder,
/// debounces filesystem events into <see cref="IVSCodeFiles.SaveAsync"/> calls, and tears itself
/// down on disposal.
/// </summary>
internal sealed class VSCodeSession : IAsyncDisposable
{
	private readonly IServiceProvider _rootServices;
	private readonly ILogger _logger;
	private readonly TimeSpan _debounce;
	private readonly object _lock = new();
	private readonly Dictionary<string, VSCodeFileChangeKind> _pending = new(StringComparer.Ordinal);

	private FileSystemWatcher? _watcher;
	private CancellationTokenSource? _flushCts;
	private Task? _flushTask;
	private DateTime _lastEventUtc;
	private long _lastSeenTicks;
	private bool _watcherEnabled;
	private bool _disposed;

	public VSCodeSession(
		string sessionId,
		string workspaceFolder,
		IReadOnlyDictionary<string, string> state,
		IServiceProvider rootServices,
		ILogger logger,
		TimeSpan debounce)
	{
		Context = new VSCodeSessionContext
		{
			SessionId = sessionId,
			WorkspaceFolder = workspaceFolder,
			State = state,
		};
		_rootServices = rootServices;
		_logger = logger;
		_debounce = debounce;
		_lastSeenTicks = DateTime.UtcNow.Ticks;
	}

	public VSCodeSessionContext Context { get; }

	public string SessionId => Context.SessionId;
	public string WorkspaceFolder => Context.WorkspaceFolder;

	/// <summary>
	/// Last time this session received traffic (proxy request, HTTP GET on the session endpoint,
	/// or explicit heartbeat). The idle sweeper compares this against
	/// <see cref="VSCodeSessionOptions.IdleTimeout"/> to decide when to evict the session.
	/// </summary>
	public DateTime LastSeenUtc
	{
		get => new DateTime(Interlocked.Read(ref _lastSeenTicks), DateTimeKind.Utc);
	}

	/// <summary>
	/// Bumps <see cref="LastSeenUtc"/> to the current UTC time. Safe to call from any thread; the
	/// proxy and HTTP endpoints poke this on every interaction with the session.
	/// </summary>
	public void Touch()
	{
		Interlocked.Exchange(ref _lastSeenTicks, DateTime.UtcNow.Ticks);
	}

	/// <summary>
	/// Test-only window onto the watcher's pending-change buffer so integration tests can wait for
	/// the watcher to record a filesystem event before exercising the dispose/flush path. Not part
	/// of the public surface.
	/// </summary>
	internal int PendingChangeCount
	{
		get { lock (_lock) { return _pending.Count; } }
	}

	/// <summary>
	/// Invokes <see cref="IVSCodeFiles.InitializeAsync"/> on a freshly-resolved scoped
	/// implementation. The watcher is not yet armed, so any files written here will not produce a
	/// spurious save callback.
	/// </summary>
	public async Task InitializeAsync(CancellationToken cancellationToken)
	{
		await using var scope = _rootServices.CreateAsyncScope();
		var provider = scope.ServiceProvider.GetRequiredService<IVSCodeFiles>();
		await provider.InitializeAsync(Context, cancellationToken).ConfigureAwait(false);
	}

	/// <summary>
	/// Arms the FileSystemWatcher. Must be called after <see cref="InitializeAsync"/> completes so
	/// the initial population doesn't generate save events.
	/// </summary>
	public void StartWatching()
	{
		if (_watcherEnabled)
		{
			return;
		}

		var watcher = new FileSystemWatcher(WorkspaceFolder)
		{
			IncludeSubdirectories = true,
			NotifyFilter = NotifyFilters.FileName
				| NotifyFilters.DirectoryName
				| NotifyFilters.LastWrite
				| NotifyFilters.Size
				| NotifyFilters.CreationTime,
			InternalBufferSize = 64 * 1024,
		};

		watcher.Created += OnCreated;
		watcher.Changed += OnChanged;
		watcher.Deleted += OnDeleted;
		watcher.Renamed += OnRenamed;
		watcher.Error += OnError;

		watcher.EnableRaisingEvents = true;

		_watcher = watcher;
		_watcherEnabled = true;
	}

	private void OnCreated(object sender, FileSystemEventArgs e) =>
		Record(e.FullPath, VSCodeFileChangeKind.Created);

	private void OnChanged(object sender, FileSystemEventArgs e) =>
		Record(e.FullPath, VSCodeFileChangeKind.Modified);

	private void OnDeleted(object sender, FileSystemEventArgs e) =>
		Record(e.FullPath, VSCodeFileChangeKind.Deleted);

	private void OnRenamed(object sender, RenamedEventArgs e)
	{
		Record(e.OldFullPath, VSCodeFileChangeKind.Deleted);
		Record(e.FullPath, VSCodeFileChangeKind.Created);
	}

	private void OnError(object sender, ErrorEventArgs e)
	{
		_logger.LogWarning(e.GetException(),
			"FileSystemWatcher error in session {SessionId}; some changes may be missed.", SessionId);
	}

	private void Record(string fullPath, VSCodeFileChangeKind kind)
	{
		if (_disposed)
		{
			return;
		}

		if (Directory.Exists(fullPath))
		{
			// Skip directory events — only file changes are reported up. Recursive watcher will
			// fire on the contained files separately.
			return;
		}

		var relative = ToRelative(fullPath);
		if (relative is null)
		{
			return;
		}

		lock (_lock)
		{
			if (_pending.TryGetValue(relative, out var existing))
			{
				// A Deleted wins outright; otherwise Created beats Modified so callers can
				// distinguish brand-new files from in-place edits.
				if (kind == VSCodeFileChangeKind.Deleted
					|| (existing == VSCodeFileChangeKind.Modified && kind == VSCodeFileChangeKind.Created))
				{
					_pending[relative] = kind;
				}
			}
			else
			{
				_pending[relative] = kind;
			}

			_lastEventUtc = DateTime.UtcNow;
		}

		EnsureFlushTask();
	}

	private string? ToRelative(string fullPath)
	{
		var root = WorkspaceFolder;
		if (string.IsNullOrEmpty(fullPath))
		{
			return null;
		}

		var rootSlash = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
		if (!fullPath.StartsWith(rootSlash, StringComparison.Ordinal)
			&& !fullPath.Equals(root, StringComparison.Ordinal))
		{
			return null;
		}

		var rel = fullPath.Length <= rootSlash.Length
			? string.Empty
			: fullPath[rootSlash.Length..];
		return rel.Replace(Path.DirectorySeparatorChar, '/');
	}

	private void EnsureFlushTask()
	{
		lock (_lock)
		{
			if (_flushTask is { IsCompleted: false })
			{
				return;
			}

			_flushCts?.Dispose();
			_flushCts = new CancellationTokenSource();
			_flushTask = Task.Run(() => FlushLoopAsync(_flushCts.Token));
		}
	}

	private async Task FlushLoopAsync(CancellationToken cancellationToken)
	{
		try
		{
			while (!cancellationToken.IsCancellationRequested)
			{
				TimeSpan wait;
				lock (_lock)
				{
					var elapsed = DateTime.UtcNow - _lastEventUtc;
					if (elapsed >= _debounce)
					{
						if (_pending.Count == 0)
						{
							return;
						}
						break;
					}
					wait = _debounce - elapsed;
				}

				try
				{
					await Task.Delay(wait, cancellationToken).ConfigureAwait(false);
				}
				catch (OperationCanceledException)
				{
					return;
				}
			}

			await FlushPendingAsync(cancellationToken).ConfigureAwait(false);
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "Unhandled exception in flush loop for session {SessionId}.", SessionId);
		}
	}

	/// <summary>
	/// Drains the current batch of changes and runs <see cref="IVSCodeFiles.SaveAsync"/>. Safe to
	/// call when there are no pending changes — it's a no-op in that case.
	/// </summary>
	public async Task FlushPendingAsync(CancellationToken cancellationToken)
	{
		List<VSCodeFileChange> batch;
		lock (_lock)
		{
			if (_pending.Count == 0)
			{
				return;
			}

			batch = new List<VSCodeFileChange>(_pending.Count);
			foreach (var (path, kind) in _pending)
			{
				batch.Add(new VSCodeFileChange(path, kind));
			}
			_pending.Clear();
		}

		try
		{
			await using var scope = _rootServices.CreateAsyncScope();
			var provider = scope.ServiceProvider.GetRequiredService<IVSCodeFiles>();
			await provider.SaveAsync(Context, batch, cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
			throw;
		}
		catch (Exception ex)
		{
			_logger.LogError(ex,
				"IVSCodeFiles.SaveAsync threw for session {SessionId}; {Count} change(s) will be retried on the next flush.",
				SessionId, batch.Count);

			// Re-queue the failed batch so the caller can retry. Deleted events that race with a
			// newly-created file are kept consistent with the merge rules in Record().
			lock (_lock)
			{
				foreach (var change in batch)
				{
					if (!_pending.ContainsKey(change.RelativePath))
					{
						_pending[change.RelativePath] = change.Kind;
					}
				}
				_lastEventUtc = DateTime.UtcNow;
			}
		}
	}

	public async ValueTask DisposeAsync()
	{
		if (_disposed)
		{
			return;
		}
		_disposed = true;

		try
		{
			if (_watcher is not null)
			{
				_watcher.EnableRaisingEvents = false;
				_watcher.Created -= OnCreated;
				_watcher.Changed -= OnChanged;
				_watcher.Deleted -= OnDeleted;
				_watcher.Renamed -= OnRenamed;
				_watcher.Error -= OnError;
				_watcher.Dispose();
				_watcher = null;
			}

			// Cancel any debounce sleep currently in flight so the flush loop unwinds promptly;
			// we'll do an explicit final drain below to make sure no pending changes are lost.
			CancellationTokenSource? cts;
			Task? flush;
			lock (_lock)
			{
				cts = _flushCts;
				flush = _flushTask;
			}
			cts?.Cancel();
			if (flush is not null)
			{
				try { await flush.ConfigureAwait(false); }
				catch { /* logged inside FlushLoopAsync */ }
			}

			// Final drain so the application sees the last batch even if the user closed without
			// triggering the debounce timer.
			try
			{
				await FlushPendingAsync(CancellationToken.None).ConfigureAwait(false);
			}
			catch (Exception ex)
			{
				_logger.LogError(ex, "Final flush failed for session {SessionId}.", SessionId);
			}
		}
		finally
		{
			_flushCts?.Dispose();

			try
			{
				if (Directory.Exists(WorkspaceFolder))
				{
					Directory.Delete(WorkspaceFolder, recursive: true);
				}
			}
			catch (Exception ex)
			{
				_logger.LogWarning(ex,
					"Failed to remove session workspace folder {Folder}; it will be left on disk.",
					WorkspaceFolder);
			}
		}
	}
}
