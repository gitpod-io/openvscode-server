// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Registration helpers that wire the embedded OpenVSCode Server into an
/// <see cref="IServiceCollection"/>.
/// </summary>
public static class OpenVSCodeServerServiceCollectionExtensions
{
	/// <summary>
	/// Registers the OpenVSCode Server hosted service and supporting types.
	/// </summary>
	public static IServiceCollection AddOpenVSCodeServer(this IServiceCollection services)
		=> services.AddOpenVSCodeServer(_ => { });

	/// <summary>
	/// Registers the OpenVSCode Server hosted service and lets the caller configure options.
	/// </summary>
	public static IServiceCollection AddOpenVSCodeServer(
		this IServiceCollection services,
		Action<OpenVSCodeServerOptions> configure)
	{
		ArgumentNullException.ThrowIfNull(services);
		ArgumentNullException.ThrowIfNull(configure);

		services.AddOptions<OpenVSCodeServerOptions>().Configure(configure);

		services.TryAddSingleton<OpenVSCodeServerDownloader>();
		services.TryAddSingleton<EmbeddedDistribution>();
		services.TryAddSingleton<OpenVSCodeServerMetrics>();
		services.TryAddSingleton<OpenVSCodeServerProcess>();
		services.TryAddSingleton<OpenVSCodeServerProxy>();

		// IHostedService registrations are additive — guard with a marker singleton so multiple
		// AddOpenVSCodeServer calls don't run the same hosted service twice.
		if (!services.Any(d => d.ImplementationType == typeof(HostedServiceMarker)))
		{
			services.AddSingleton<HostedServiceMarker>();
			services.AddHostedService(sp => sp.GetRequiredService<OpenVSCodeServerProcess>());
		}

		return services;
	}

	/// <summary>
	/// Registers an <see cref="IVSCodeFiles"/> implementation that drives the per-session workspace
	/// folder. Required before
	/// <see cref="OpenVSCodeServerEndpointRouteBuilderExtensions.MapOpenVSCodeServerSessions"/>
	/// can be used. The implementation is registered with scoped lifetime so it can pull in scoped
	/// services such as <c>DbContext</c> or auth context safely.
	/// </summary>
	public static IServiceCollection AddVSCodeFiles<TImplementation>(this IServiceCollection services)
		where TImplementation : class, IVSCodeFiles
	{
		ArgumentNullException.ThrowIfNull(services);

		// Ensure the options instance is bound even when AddVSCodeFiles is called in isolation
		// (e.g. in unit tests that don't want the full Node-process hosted service).
		services.AddOptions<OpenVSCodeServerOptions>();
		services.AddScoped<IVSCodeFiles, TImplementation>();
		services.TryAddSingleton<VSCodeSessionManager>();

		if (!services.Any(d => d.ImplementationType == typeof(VSCodeSessionManagerMarker)))
		{
			services.AddSingleton<VSCodeSessionManagerMarker>();
			services.AddHostedService(sp => sp.GetRequiredService<VSCodeSessionManager>());
		}

		return services;
	}

	/// <summary>
	/// Adds an <see cref="IHealthCheck"/> that reports <see cref="HealthStatus.Healthy"/> once the
	/// embedded openvscode-server has emitted its "Web UI available" banner. Use this to wire a
	/// readiness probe into the ASP.NET Core health-check pipeline without writing a custom
	/// endpoint.
	/// </summary>
	/// <param name="builder">The health-checks builder returned by <c>AddHealthChecks()</c>.</param>
	/// <param name="name">Logical health-check name. Defaults to <c>"openvscode-server"</c>.</param>
	/// <param name="failureStatus">Status to report when the child is not yet ready or has
	/// crashed. Defaults to <see cref="HealthStatus.Unhealthy"/>.</param>
	/// <param name="tags">Optional tag set, e.g. <c>["ready"]</c> for filtering.</param>
	public static IHealthChecksBuilder AddOpenVSCodeServerCheck(
		this IHealthChecksBuilder builder,
		string name = "openvscode-server",
		HealthStatus? failureStatus = null,
		IEnumerable<string>? tags = null)
	{
		ArgumentNullException.ThrowIfNull(builder);

		return builder.AddCheck<OpenVSCodeServerHealthCheck>(
			name,
			failureStatus,
			tags ?? Array.Empty<string>());
	}

	private sealed class HostedServiceMarker;
	private sealed class VSCodeSessionManagerMarker;
}
