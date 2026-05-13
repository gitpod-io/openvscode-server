// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Owns the lifecycle of the bundled Node-based openvscode-server child process and exposes a
/// <see cref="ReadyUri"/> that the reverse-proxy middleware forwards traffic to.
/// </summary>
internal sealed class OpenVSCodeServerProcess : IHostedService, IAsyncDisposable
{
	private static readonly Regex WebUiReadyRegex =
		new("Web UI available at (?<url>http[s]?://[^\\s]+)", RegexOptions.Compiled);

	private readonly ILogger<OpenVSCodeServerProcess> _logger;
	private readonly EmbeddedDistribution _distribution;
	private readonly OpenVSCodeServerOptions _options;
	private readonly TaskCompletionSource<Uri> _readyTcs =
		new(TaskCreationOptions.RunContinuationsAsynchronously);
	private readonly object _stateLock = new();

	private string? _installRoot;
	private int _boundPort;
	private Process? _process;
	private Channel<string>? _stderrLog;
	private CancellationTokenSource? _runCts;
	private CancellationTokenSource? _shutdownCts;
	private bool _shutdownRequested;
	private int _restartAttempts;
	private DateTime _currentLaunchAt;

	public OpenVSCodeServerProcess(
		ILogger<OpenVSCodeServerProcess> logger,
		EmbeddedDistribution distribution,
		IOptions<OpenVSCodeServerOptions> options)
	{
		_logger = logger;
		_distribution = distribution;
		_options = options.Value;
		ResolvedConnectionToken = ResolveConnectionToken(_options);
	}

	/// <summary>
	/// Resolves once the child server is listening. Throws if the initial startup fails or times
	/// out. Subsequent crashes are recovered transparently when
	/// <see cref="OpenVSCodeServerOptions.RestartOnCrash"/> is enabled; the same <see cref="Uri"/>
	/// remains valid because the bound port is pinned across restarts.
	/// </summary>
	public Task<Uri> ReadyUri => _readyTcs.Task;

	/// <summary>
	/// The connection token the child server is/will be started with, or <c>null</c> when
	/// <see cref="OpenVSCodeServerOptions.WithoutConnectionToken"/> is true. May be auto-generated
	/// if the caller asked for token-auth but did not supply one explicitly.
	/// </summary>
	public string? ResolvedConnectionToken { get; }

	private static string? ResolveConnectionToken(OpenVSCodeServerOptions options)
	{
		if (options.WithoutConnectionToken)
		{
			return null;
		}
		if (!string.IsNullOrEmpty(options.ConnectionToken))
		{
			return options.ConnectionToken;
		}
		// Auto-generate a 256-bit URL-safe token. The upstream server treats this as opaque.
		var bytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
		return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
	}

	public async Task StartAsync(CancellationToken cancellationToken)
	{
		_installRoot = _distribution.Materialize(_options);
		_boundPort = _options.Port ?? AllocateEphemeralPort(_options.Host);
		_shutdownCts = new CancellationTokenSource();

		Launch();

		_runCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		using var timeoutCts = new CancellationTokenSource(_options.StartupTimeout);
		using var linked = CancellationTokenSource.CreateLinkedTokenSource(_runCts.Token, timeoutCts.Token);

		var winner = await Task.WhenAny(_readyTcs.Task, Task.Delay(Timeout.Infinite, linked.Token))
			.ConfigureAwait(false);
		if (winner != _readyTcs.Task)
		{
			var tail = DrainStderr();
			throw new TimeoutException(
				$"openvscode-server did not become ready within {_options.StartupTimeout.TotalSeconds:N0}s. "
				+ $"Recent stderr:\n{tail}");
		}

		// Surface any failure that may have raced startup.
		await _readyTcs.Task.ConfigureAwait(false);
	}

	public async Task StopAsync(CancellationToken cancellationToken)
	{
		_shutdownRequested = true;
		_shutdownCts?.Cancel();
		_runCts?.Cancel();

		Process? toAwait;
		lock (_stateLock)
		{
			toAwait = _process;
		}

		if (toAwait is null)
		{
			return;
		}

		try
		{
			if (!toAwait.HasExited)
			{
				_logger.LogInformation("Stopping openvscode-server (pid {Pid}).", toAwait.Id);
				try
				{
					toAwait.Kill(entireProcessTree: true);
				}
				catch (InvalidOperationException) { /* already exited */ }
				catch (Exception ex)
				{
					_logger.LogWarning(ex, "Failed to kill openvscode-server child process; continuing shutdown.");
				}
			}

			using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			cts.CancelAfter(TimeSpan.FromSeconds(5));
			await toAwait.WaitForExitAsync(cts.Token).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			// Best effort.
		}
	}

	public async ValueTask DisposeAsync()
	{
		try
		{
			await StopAsync(CancellationToken.None).ConfigureAwait(false);
		}
		catch
		{
			// ignored — best-effort cleanup
		}

		Process? toDispose;
		lock (_stateLock)
		{
			toDispose = _process;
			_process = null;
		}
		toDispose?.Dispose();
		_shutdownCts?.Dispose();
	}

	private void Launch()
	{
		if (_installRoot is null)
		{
			throw new InvalidOperationException("Launch called before StartAsync resolved the install root.");
		}

		var nodeExecutable = ResolveNodeExecutable(_installRoot);
		var serverMain = Path.Combine(_installRoot, "out", "server-main.js");
		var arguments = BuildArguments(serverMain, _boundPort);

		var psi = new ProcessStartInfo
		{
			FileName = nodeExecutable,
			WorkingDirectory = _installRoot,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			RedirectStandardInput = false,
			UseShellExecute = false,
			CreateNoWindow = true,
		};

		foreach (var arg in arguments)
		{
			psi.ArgumentList.Add(arg);
		}

		// Pass-through host environment + user overrides.
		foreach (var (key, value) in _options.EnvironmentOverrides)
		{
			psi.Environment[key] = value;
		}

		_logger.LogInformation("Launching openvscode-server: {Exec} {Args}", nodeExecutable, string.Join(' ', arguments));

		var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
		var stderrLog = Channel.CreateBounded<string>(new BoundedChannelOptions(256)
		{
			FullMode = BoundedChannelFullMode.DropOldest,
			SingleReader = true,
			SingleWriter = false,
		});

		process.OutputDataReceived += OnStdout;
		process.ErrorDataReceived += OnStderr;
		process.Exited += OnExited;

		if (!process.Start())
		{
			throw new InvalidOperationException("Failed to start node process for openvscode-server.");
		}

		process.BeginOutputReadLine();
		process.BeginErrorReadLine();

		lock (_stateLock)
		{
			_process = process;
			_stderrLog = stderrLog;
			_currentLaunchAt = DateTime.UtcNow;
		}
	}

	private IReadOnlyList<string> BuildArguments(string serverMain, int port)
	{
		var args = new List<string>
		{
			serverMain,
			"--host", _options.Host,
			"--port", port.ToString(CultureInfo.InvariantCulture),
		};

		if (_options.WithoutConnectionToken)
		{
			args.Add("--without-connection-token");
		}
		else if (!string.IsNullOrEmpty(ResolvedConnectionToken))
		{
			args.Add("--connection-token");
			args.Add(ResolvedConnectionToken);
		}

		if (!string.IsNullOrEmpty(_options.WorkspaceFolder))
		{
			args.Add("--default-folder");
			args.Add(_options.WorkspaceFolder!);
		}

		// Mount under a sub-path so the child server emits correct absolute URLs.
		if (!string.IsNullOrEmpty(_options.PathPrefix) && _options.PathPrefix != "/")
		{
			args.Add("--server-base-path");
			args.Add(_options.PathPrefix);
		}

		foreach (var extra in _options.AdditionalArguments)
		{
			args.Add(extra);
		}

		return args;
	}

	private static string ResolveNodeExecutable(string installRoot)
	{
		// The packaged distribution ships its own Node binary at the install root.
		var bundled = OperatingSystem.IsWindows()
			? Path.Combine(installRoot, "node.exe")
			: Path.Combine(installRoot, "node");

		if (File.Exists(bundled))
		{
			return bundled;
		}

		// Fall back to PATH if the bundled binary is unavailable (e.g. when ExternalServerPath
		// points at a layout that excludes it).
		return OperatingSystem.IsWindows() ? "node.exe" : "node";
	}

	private static int AllocateEphemeralPort(string host)
	{
		var address = IPAddress.TryParse(host, out var ip) ? ip : IPAddress.Loopback;
		using var listener = new TcpListener(address, 0);
		listener.Start();
		try
		{
			return ((IPEndPoint)listener.LocalEndpoint).Port;
		}
		finally
		{
			listener.Stop();
		}
	}

	private void OnStdout(object? sender, DataReceivedEventArgs e)
	{
		if (e.Data is null)
		{
			return;
		}

		_logger.LogDebug("[openvscode-server][stdout] {Line}", e.Data);

		if (!_readyTcs.Task.IsCompleted)
		{
			var match = WebUiReadyRegex.Match(e.Data);
			if (match.Success && Uri.TryCreate(match.Groups["url"].Value, UriKind.Absolute, out var uri))
			{
				_readyTcs.TrySetResult(uri);
			}
		}
	}

	private void OnStderr(object? sender, DataReceivedEventArgs e)
	{
		if (e.Data is null)
		{
			return;
		}

		_logger.LogDebug("[openvscode-server][stderr] {Line}", e.Data);
		_stderrLog?.Writer.TryWrite(e.Data);
	}

	private void OnExited(object? sender, EventArgs e)
	{
		var process = sender as Process;
		var exitCode = process?.ExitCode ?? -1;
		var aliveFor = DateTime.UtcNow - _currentLaunchAt;
		_logger.LogWarning("openvscode-server child process exited (exit code {ExitCode}) after {Alive:N1}s.",
			exitCode, aliveFor.TotalSeconds);

		if (!_readyTcs.Task.IsCompleted)
		{
			var tail = DrainStderr();
			_readyTcs.TrySetException(new InvalidOperationException(
				$"openvscode-server exited (code {exitCode}) before becoming ready. Recent stderr:\n{tail}"));
			return;
		}

		if (_shutdownRequested || !_options.RestartOnCrash)
		{
			return;
		}

		// Reset the retry counter when the previous instance survived long enough.
		if (aliveFor >= _options.RestartAttemptResetWindow)
		{
			_restartAttempts = 0;
		}

		_ = Task.Run(() => RestartLoopAsync(_shutdownCts?.Token ?? CancellationToken.None));
	}

	private async Task RestartLoopAsync(CancellationToken cancellationToken)
	{
		while (!cancellationToken.IsCancellationRequested && !_shutdownRequested)
		{
			_restartAttempts++;
			if (_options.MaxRestartAttempts > 0 && _restartAttempts > _options.MaxRestartAttempts)
			{
				_logger.LogError(
					"openvscode-server exceeded MaxRestartAttempts ({Max}); giving up. The reverse proxy will keep returning 502 until the host restarts.",
					_options.MaxRestartAttempts);
				return;
			}

			var delay = ComputeBackoff(_restartAttempts);
			_logger.LogWarning("Restarting openvscode-server in {Delay:N1}s (attempt {Attempt}/{Max}).",
				delay.TotalSeconds, _restartAttempts,
				_options.MaxRestartAttempts == 0 ? "∞" : _options.MaxRestartAttempts.ToString(CultureInfo.InvariantCulture));

			try
			{
				await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
			}
			catch (OperationCanceledException)
			{
				return;
			}

			Process? previous;
			lock (_stateLock)
			{
				previous = _process;
			}
			previous?.Dispose();

			try
			{
				Launch();
				return;
			}
			catch (Exception ex)
			{
				_logger.LogError(ex, "Failed to relaunch openvscode-server (attempt {Attempt}).", _restartAttempts);
				// Loop and try again after the next back-off.
			}
		}
	}

	private TimeSpan ComputeBackoff(int attempt)
	{
		// 2^(attempt-1) * initial, capped at max. attempt=1 -> initial; attempt=2 -> 2*initial; …
		var multiplier = Math.Pow(2, Math.Max(0, attempt - 1));
		var rawSeconds = _options.RestartInitialDelay.TotalSeconds * multiplier;
		var cappedSeconds = Math.Min(rawSeconds, _options.RestartMaxDelay.TotalSeconds);
		return TimeSpan.FromSeconds(cappedSeconds);
	}

	private string DrainStderr()
	{
		var log = _stderrLog;
		if (log is null)
		{
			return string.Empty;
		}

		var lines = new List<string>();
		while (log.Reader.TryRead(out var line))
		{
			lines.Add(line);
		}
		return string.Join('\n', lines);
	}
}
