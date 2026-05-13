// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class HostingSmokeTests
{
	internal static bool CanReachInstall(out string? reason)
	{
		if (EmbeddedDistribution.HasEmbeddedDistribution())
		{
			reason = null;
			return true;
		}

		var external = Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");
		if (!string.IsNullOrEmpty(external)
			&& File.Exists(Path.Combine(external, "out", "server-main.js")))
		{
			reason = null;
			return true;
		}

		reason = "No embedded openvscode-server distribution is available and OPENVSCODE_EXTERNAL_PATH is not set.";
		return false;
	}

	/// <summary>
	/// Builds a WebApplicationBuilder that points Kestrel at an isolated ephemeral port. The
	/// TestHost project's appsettings.json (copied into this assembly's output folder via the
	/// project reference) pins Kestrel to a fixed port via the <c>Kestrel:Endpoints</c> section,
	/// which would collide between tests; this helper overrides that JSON config with the supplied
	/// ephemeral port so each test gets its own listener.
	/// </summary>
	internal static WebApplicationBuilder CreateIsolatedBuilder(int port)
	{
		var builder = WebApplication.CreateBuilder();

		// Replace the JSON-defined Kestrel endpoint URL with the ephemeral one so we end up
		// listening exclusively on the test-allocated port.
		builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
		{
			["Kestrel:Endpoints:Http:Url"] = $"http://127.0.0.1:{port}",
		});

		builder.Logging.SetMinimumLevel(LogLevel.Warning);
		return builder;
	}

	[Fact]
	public async Task Host_Boots_And_Serves_Workbench()
	{
		if (!CanReachInstall(out var skip))
		{
			// Surface as a soft skip rather than a failure when no distribution is available.
			// xUnit doesn't ship a `[SkippableFact]` out of the box; just assert true so the
			// test inventory still records it.
			Assert.True(true, skip);
			return;
		}

		var port = AllocateFreePort();
		var external = Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");

		var builder = CreateIsolatedBuilder(port);
		builder.Services.AddOpenVSCodeServer(options =>
		{
			options.ExternalServerPath = string.IsNullOrEmpty(external) ? null : external;
			options.WithoutConnectionToken = true;
			options.StartupTimeout = TimeSpan.FromMinutes(2);
		});

		using var app = builder.Build();
		app.MapGet("/healthz", () => Microsoft.AspNetCore.Http.Results.Ok());
		app.MapOpenVSCodeServer("/ide");

		await app.StartAsync();
		try
		{
			using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

			var health = await http.GetAsync($"http://127.0.0.1:{port}/healthz");
			Assert.Equal(HttpStatusCode.OK, health.StatusCode);

			var workbench = await http.GetAsync($"http://127.0.0.1:{port}/ide/");
			Assert.True(
				workbench.IsSuccessStatusCode || workbench.StatusCode == HttpStatusCode.Redirect,
				$"Unexpected status {(int)workbench.StatusCode} on /ide/");

			// When we got a 200 the body should look like the VS Code workbench shell. We don't
			// strictly require this (302 to the workbench is also valid) but assert it whenever
			// the server served the HTML directly so a future regression is loud.
			if (workbench.IsSuccessStatusCode)
			{
				var body = await workbench.Content.ReadAsStringAsync();
				Assert.Contains("<html", body, StringComparison.OrdinalIgnoreCase);
				// The workbench shell loads through a bootstrap script and exposes window.product
				// inside an inline configuration JSON. Either marker is enough to catch a wholesale
				// proxy regression that returns the wrong page.
				var looksLikeWorkbench =
					body.Contains("Visual Studio Code", StringComparison.OrdinalIgnoreCase)
					|| body.Contains("workbench", StringComparison.OrdinalIgnoreCase)
					|| body.Contains("vscode-server", StringComparison.OrdinalIgnoreCase);
				Assert.True(looksLikeWorkbench,
					"Workbench HTML did not contain any VS Code marker — the proxy may be returning the wrong page.");
			}
		}
		finally
		{
			await app.StopAsync();
		}
	}

	[Fact]
	public async Task Host_RecoversFrom_ChildCrash()
	{
		if (!CanReachInstall(out var skip))
		{
			Assert.True(true, skip);
			return;
		}
		if (!OperatingSystem.IsLinux())
		{
			// pgrep + kill below assume a POSIX environment.
			Assert.True(true, "Restart smoke test only runs on Linux.");
			return;
		}

		var port = AllocateFreePort();
		var external = Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");

		var builder = CreateIsolatedBuilder(port);
		builder.Services.AddOpenVSCodeServer(options =>
		{
			options.ExternalServerPath = string.IsNullOrEmpty(external) ? null : external;
			options.WithoutConnectionToken = true;
			options.StartupTimeout = TimeSpan.FromMinutes(2);
			options.RestartOnCrash = true;
			options.RestartInitialDelay = TimeSpan.FromMilliseconds(200);
			options.MaxRestartAttempts = 3;
		});

		using var app = builder.Build();
		app.MapOpenVSCodeServer("/ide");

		await app.StartAsync();
		try
		{
			using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

			// Confirm the first instance is serving.
			var before = await http.GetAsync($"http://127.0.0.1:{port}/ide/");
			Assert.True(before.IsSuccessStatusCode || before.StatusCode == HttpStatusCode.Redirect);

			// Kill the child node process. The watchdog should relaunch it on the same port.
			var killed = KillChildNodeProcess();
			Assert.True(killed, "Expected to find a child openvscode-server node process to kill.");

			// Wait for the restart to take hold, then probe again. The same Kestrel port should
			// route to the freshly-spawned upstream.
			HttpResponseMessage? after = null;
			for (var attempt = 0; attempt < 30; attempt++)
			{
				await Task.Delay(TimeSpan.FromSeconds(1));
				try
				{
					after = await http.GetAsync($"http://127.0.0.1:{port}/ide/");
					if (after.IsSuccessStatusCode || after.StatusCode == HttpStatusCode.Redirect)
					{
						break;
					}
				}
				catch (HttpRequestException)
				{
					// Upstream is still respawning; keep polling.
				}
			}

			Assert.NotNull(after);
			Assert.True(
				after!.IsSuccessStatusCode || after.StatusCode == HttpStatusCode.Redirect,
				$"openvscode-server did not recover within 30s — last status was {(int)after.StatusCode}.");
		}
		finally
		{
			await app.StopAsync();
		}
	}

	private static bool KillChildNodeProcess()
	{
		// Best effort: send SIGKILL to any node child that's running our server-main.js.
		var psi = new System.Diagnostics.ProcessStartInfo("pkill", "-9 -f openvscode-server.*out/server-main.js")
		{
			RedirectStandardError = true,
			RedirectStandardOutput = true,
		};
		using var pkill = System.Diagnostics.Process.Start(psi);
		if (pkill is null)
		{
			return false;
		}
		pkill.WaitForExit(5000);
		return pkill.ExitCode == 0;
	}

	[Fact]
	public async Task Host_Proxies_With_ConnectionToken()
	{
		if (!CanReachInstall(out var skip))
		{
			Assert.True(true, skip);
			return;
		}

		var port = AllocateFreePort();
		var external = Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");

		var builder = CreateIsolatedBuilder(port);
		builder.Services.AddOpenVSCodeServer(options =>
		{
			options.ExternalServerPath = string.IsNullOrEmpty(external) ? null : external;
			options.WithoutConnectionToken = false;
			options.ConnectionToken = "smoke-token-" + Guid.NewGuid().ToString("N");
			options.StartupTimeout = TimeSpan.FromMinutes(2);
		});

		using var app = builder.Build();
		app.MapOpenVSCodeServer("/ide");

		await app.StartAsync();
		try
		{
			using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
			// The browser doesn't supply the token — the proxy injects it on the way upstream.
			var workbench = await http.GetAsync($"http://127.0.0.1:{port}/ide/");
			Assert.True(
				workbench.IsSuccessStatusCode || workbench.StatusCode == HttpStatusCode.Redirect,
				$"Unexpected status {(int)workbench.StatusCode} on /ide/ — upstream may have rejected the proxied request.");
		}
		finally
		{
			await app.StopAsync();
		}
	}

	[Fact]
	public async Task Host_Boots_Via_RuntimeDownload_When_Enabled()
	{
		// Two opt-ins required: the runtime downloader has to be enabled in options, and the test
		// itself only runs when the operator has explicitly allowed network access. Otherwise we
		// soft-skip — there is no embedded archive in CI and we don't want a transient GitHub
		// outage to fail every PR run.
		if (Environment.GetEnvironmentVariable("OPENVSCODE_ENABLE_DOWNLOAD_TEST") != "1")
		{
			Assert.True(true, "Set OPENVSCODE_ENABLE_DOWNLOAD_TEST=1 to exercise the runtime downloader path.");
			return;
		}

		if (!OperatingSystem.IsLinux())
		{
			// The gitpod-io release only ships Linux artifacts at the time of writing.
			Assert.True(true, "Runtime download test only runs on Linux.");
			return;
		}

		var port = AllocateFreePort();
		var cacheDir = Directory.CreateTempSubdirectory("openvscode-download-smoke-").FullName;

		var builder = CreateIsolatedBuilder(port);
		builder.Services.AddOpenVSCodeServer(options =>
		{
			options.WithoutConnectionToken = true;
			options.StartupTimeout = TimeSpan.FromMinutes(3);
			options.Download.Enabled = true;
			options.Download.CacheDirectory = cacheDir;
		});

		using var app = builder.Build();
		app.MapGet("/healthz", () => Microsoft.AspNetCore.Http.Results.Ok());
		app.MapOpenVSCodeServer("/ide");

		try
		{
			await app.StartAsync();
			try
			{
				using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
				var health = await http.GetAsync($"http://127.0.0.1:{port}/healthz");
				Assert.Equal(HttpStatusCode.OK, health.StatusCode);
			}
			finally
			{
				await app.StopAsync();
			}
		}
		finally
		{
			Directory.Delete(cacheDir, recursive: true);
		}
	}

	private static int AllocateFreePort()
	{
		using var listener = new TcpListener(IPAddress.Loopback, 0);
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
}
