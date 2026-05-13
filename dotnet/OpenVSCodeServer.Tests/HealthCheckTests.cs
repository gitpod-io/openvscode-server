// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class HealthCheckTests
{
	[Fact]
	public async Task Healthy_WhenReadyUri_Completed()
	{
		var process = CreateUninitializedProcess();
		CompleteReadyUri(process, new Uri("http://127.0.0.1:7000/ide"));

		var result = await new OpenVSCodeServerHealthCheckAccessor(process)
			.CheckAsync();

		Assert.Equal(HealthStatus.Healthy, result.Status);
		Assert.Contains("ready", result.Description, StringComparison.OrdinalIgnoreCase);
		Assert.NotNull(result.Data);
		Assert.Equal("http://127.0.0.1:7000/ide", result.Data["upstream"]);
	}

	[Fact]
	public async Task Unhealthy_WhenReadyUri_Pending()
	{
		var process = CreateUninitializedProcess();

		var result = await new OpenVSCodeServerHealthCheckAccessor(process)
			.CheckAsync();

		Assert.Equal(HealthStatus.Unhealthy, result.Status);
		Assert.Contains("starting", result.Description, StringComparison.OrdinalIgnoreCase);
	}

	[Fact]
	public async Task Unhealthy_WhenReadyUri_Faulted()
	{
		var process = CreateUninitializedProcess();
		FaultReadyUri(process, new InvalidOperationException("upstream boot failed"));

		var result = await new OpenVSCodeServerHealthCheckAccessor(process)
			.CheckAsync();

		Assert.Equal(HealthStatus.Unhealthy, result.Status);
		Assert.NotNull(result.Exception);
		Assert.Contains("upstream boot failed", result.Exception!.Message);
	}

	[Fact]
	public void AddOpenVSCodeServerCheck_RegistersNamedCheck()
	{
		var services = new ServiceCollection();
		services.AddLogging();
		services.AddOpenVSCodeServer();
		services.AddHealthChecks().AddOpenVSCodeServerCheck(tags: new[] { "ready" });

		var provider = services.BuildServiceProvider();
		var registrations = provider
			.GetRequiredService<Microsoft.Extensions.Options.IOptions<HealthCheckServiceOptions>>()
			.Value.Registrations
			.ToList();

		Assert.Contains(registrations, r => r.Name == "openvscode-server");
		Assert.Contains(registrations, r => r.Tags.Contains("ready"));
	}

	private static OpenVSCodeServerProcess CreateUninitializedProcess()
	{
		// Sidestep the constructor (which would resolve a real install + DI graph) by getting a
		// bare instance and seeding the single field the health check actually inspects.
		var process = (OpenVSCodeServerProcess)System.Runtime.CompilerServices.RuntimeHelpers
			.GetUninitializedObject(typeof(OpenVSCodeServerProcess));
		var tcsField = typeof(OpenVSCodeServerProcess)
			.GetField("_readyTcs", BindingFlags.Instance | BindingFlags.NonPublic);
		Assert.NotNull(tcsField);
		tcsField!.SetValue(process, new TaskCompletionSource<Uri>(TaskCreationOptions.RunContinuationsAsynchronously));
		return process;
	}

	private static void CompleteReadyUri(OpenVSCodeServerProcess process, Uri uri)
	{
		var tcs = GetTcs(process);
		tcs.TrySetResult(uri);
	}

	private static void FaultReadyUri(OpenVSCodeServerProcess process, Exception exception)
	{
		var tcs = GetTcs(process);
		tcs.TrySetException(exception);
	}

	private static TaskCompletionSource<Uri> GetTcs(OpenVSCodeServerProcess process)
	{
		var field = typeof(OpenVSCodeServerProcess)
			.GetField("_readyTcs", BindingFlags.Instance | BindingFlags.NonPublic);
		Assert.NotNull(field);
		return (TaskCompletionSource<Uri>)field!.GetValue(process)!;
	}

	private sealed class OpenVSCodeServerHealthCheckAccessor
	{
		private readonly OpenVSCodeServerHealthCheck _check;

		public OpenVSCodeServerHealthCheckAccessor(OpenVSCodeServerProcess process)
		{
			_check = (OpenVSCodeServerHealthCheck)Activator.CreateInstance(
				typeof(OpenVSCodeServerHealthCheck),
				BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public,
				binder: null,
				args: new object[] { process },
				culture: null)!;
		}

		public Task<HealthCheckResult> CheckAsync()
			=> _check.CheckHealthAsync(
				new HealthCheckContext { Registration = new HealthCheckRegistration("test", _check, failureStatus: null, tags: null) });
	}
}
