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

	private Process? _process;
	private Channel<string>? _stderrLog;
	private CancellationTokenSource? _runCts;

	public OpenVSCodeServerProcess(
		ILogger<OpenVSCodeServerProcess> logger,
		EmbeddedDistribution distribution,
		IOptions<OpenVSCodeServerOptions> options)
	{
		_logger = logger;
		_distribution = distribution;
		_options = options.Value;
	}

	/// <summary>
	/// Resolves once the child server is listening. Throws if startup fails or times out.
	/// </summary>
	public Task<Uri> ReadyUri => _readyTcs.Task;

	public async Task StartAsync(CancellationToken cancellationToken)
	{
		var installRoot = _distribution.Materialize(_options);

		var nodeExecutable = ResolveNodeExecutable(installRoot);
		var serverMain = Path.Combine(installRoot, "out", "server-main.js");

		var port = _options.Port ?? AllocateEphemeralPort(_options.Host);
		var arguments = BuildArguments(serverMain, port);

		var psi = new ProcessStartInfo
		{
			FileName = nodeExecutable,
			WorkingDirectory = installRoot,
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

		_process = new Process { StartInfo = psi, EnableRaisingEvents = true };
		_stderrLog = Channel.CreateBounded<string>(new BoundedChannelOptions(256)
		{
			FullMode = BoundedChannelFullMode.DropOldest,
			SingleReader = true,
			SingleWriter = false,
		});

		_process.OutputDataReceived += OnStdout;
		_process.ErrorDataReceived += OnStderr;
		_process.Exited += OnExited;

		if (!_process.Start())
		{
			throw new InvalidOperationException("Failed to start node process for openvscode-server.");
		}

		_process.BeginOutputReadLine();
		_process.BeginErrorReadLine();

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
		if (_process is null)
		{
			return;
		}

		_runCts?.Cancel();

		try
		{
			if (!_process.HasExited)
			{
				_logger.LogInformation("Stopping openvscode-server (pid {Pid}).", _process.Id);
				try
				{
					_process.Kill(entireProcessTree: true);
				}
				catch (InvalidOperationException) { /* already exited */ }
				catch (Exception ex)
				{
					_logger.LogWarning(ex, "Failed to kill openvscode-server child process; continuing shutdown.");
				}
			}

			using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			cts.CancelAfter(TimeSpan.FromSeconds(5));
			await _process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
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
		_process?.Dispose();
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
		else if (!string.IsNullOrEmpty(_options.ConnectionToken))
		{
			args.Add("--connection-token");
			args.Add(_options.ConnectionToken!);
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
		var exitCode = _process?.ExitCode ?? -1;
		_logger.LogWarning("openvscode-server child process exited (exit code {ExitCode}).", exitCode);
		if (!_readyTcs.Task.IsCompleted)
		{
			var tail = DrainStderr();
			_readyTcs.TrySetException(new InvalidOperationException(
				$"openvscode-server exited (code {exitCode}) before becoming ready. Recent stderr:\n{tail}"));
		}
	}

	private string DrainStderr()
	{
		if (_stderrLog is null)
		{
			return string.Empty;
		}

		var lines = new List<string>();
		while (_stderrLog.Reader.TryRead(out var line))
		{
			lines.Add(line);
		}
		return string.Join('\n', lines);
	}
}
