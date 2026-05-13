// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class HostingSmokeTests
{
	private static bool CanReachInstall(out string? reason)
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

		var builder = WebApplication.CreateBuilder();
		// The TestHost project ships an appsettings.json that pins Kestrel to a fixed port; that
		// file is copied into the test output folder via the project reference and would otherwise
		// override UseUrls below. Bind Kestrel explicitly to bypass any configured endpoints.
		builder.WebHost.ConfigureKestrel(opts =>
		{
			opts.ListenLocalhost(port);
		});
		builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
		builder.Logging.SetMinimumLevel(LogLevel.Warning);

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

		var builder = WebApplication.CreateBuilder();
		builder.WebHost.ConfigureKestrel(opts => opts.ListenLocalhost(port));
		builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
		builder.Logging.SetMinimumLevel(LogLevel.Warning);

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
