// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// An <see cref="IHealthCheck"/> that reports the readiness of the embedded openvscode-server
/// child process. Returns <see cref="HealthStatus.Healthy"/> once the child has emitted its
/// "Web UI available" banner, and <see cref="HealthStatus.Unhealthy"/> while it is still starting
/// or after an unrecovered crash. The exact upstream URL is included in the result data so
/// operators can correlate failures with the proxy target.
/// </summary>
internal sealed class OpenVSCodeServerHealthCheck : IHealthCheck
{
	private readonly OpenVSCodeServerProcess _process;

	public OpenVSCodeServerHealthCheck(OpenVSCodeServerProcess process)
	{
		_process = process;
	}

	public Task<HealthCheckResult> CheckHealthAsync(
		HealthCheckContext context,
		CancellationToken cancellationToken = default)
	{
		var task = _process.ReadyUri;

		if (task.IsCompletedSuccessfully)
		{
			return Task.FromResult(HealthCheckResult.Healthy(
				"openvscode-server is ready.",
				data: new Dictionary<string, object>
				{
					["upstream"] = task.Result.ToString(),
				}));
		}

		if (task.IsFaulted)
		{
			return Task.FromResult(HealthCheckResult.Unhealthy(
				"openvscode-server failed to start.",
				exception: task.Exception?.GetBaseException()));
		}

		if (task.IsCanceled)
		{
			return Task.FromResult(HealthCheckResult.Unhealthy(
				"openvscode-server startup was canceled."));
		}

		return Task.FromResult(HealthCheckResult.Unhealthy(
			"openvscode-server is still starting."));
	}
}
