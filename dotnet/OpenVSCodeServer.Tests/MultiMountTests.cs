// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class MultiMountTests
{
	[Fact]
	public void MapOpenVSCodeServer_SamePrefixTwice_IsIdempotent()
	{
		var builder = WebApplication.CreateBuilder();
		builder.WebHost.UseUrls("http://127.0.0.1:0");
		builder.Services.AddOpenVSCodeServer(opts =>
		{
			opts.ExternalServerPath = "/nonexistent-but-options-stay-valid";
		});

		using var app = builder.Build();
		app.MapOpenVSCodeServer("/ide");
		app.MapOpenVSCodeServer("/ide");

		var options = app.Services.GetRequiredService<IOptions<OpenVSCodeServerOptions>>().Value;
		Assert.Equal("/ide", options.PathPrefix);
		Assert.Empty(options.AdditionalMountPrefixes);
	}

	[Fact]
	public void MapOpenVSCodeServer_DifferentPrefixes_RecordsSecondary()
	{
		var builder = WebApplication.CreateBuilder();
		builder.WebHost.UseUrls("http://127.0.0.1:0");
		builder.Services.AddOpenVSCodeServer(opts =>
		{
			opts.ExternalServerPath = "/nonexistent-but-options-stay-valid";
		});

		using var app = builder.Build();
		app.MapOpenVSCodeServer("/ide");
		app.MapOpenVSCodeServer("/legacy");

		var options = app.Services.GetRequiredService<IOptions<OpenVSCodeServerOptions>>().Value;
		Assert.Equal("/ide", options.PathPrefix);
		Assert.Single(options.AdditionalMountPrefixes);
		Assert.Equal("/legacy", options.AdditionalMountPrefixes[0]);
	}

	[Fact]
	public async Task MapOpenVSCodeServer_TwoMounts_ShareOneProcess()
	{
		if (!HostingSmokeTests.CanReachInstall(out var skip))
		{
			Assert.True(true, skip);
			return;
		}

		var port = AllocateFreePort();
		var external = Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");

		var builder = HostingSmokeTests.CreateIsolatedBuilder(port);
		builder.Services.AddOpenVSCodeServer(options =>
		{
			options.ExternalServerPath = string.IsNullOrEmpty(external) ? null : external;
			options.WithoutConnectionToken = true;
			options.StartupTimeout = TimeSpan.FromMinutes(2);
		});

		using var app = builder.Build();
		app.MapOpenVSCodeServer("/ide");
		app.MapOpenVSCodeServer("/legacy");

		await app.StartAsync();
		try
		{
			using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };

			var primary = await http.GetAsync($"http://127.0.0.1:{port}/ide/");
			Assert.True(primary.IsSuccessStatusCode || primary.StatusCode == HttpStatusCode.Redirect);

			var secondary = await http.GetAsync($"http://127.0.0.1:{port}/legacy/");
			Assert.True(secondary.IsSuccessStatusCode || secondary.StatusCode == HttpStatusCode.Redirect,
				$"Secondary mount returned {(int)secondary.StatusCode}.");
		}
		finally
		{
			await app.StopAsync();
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
