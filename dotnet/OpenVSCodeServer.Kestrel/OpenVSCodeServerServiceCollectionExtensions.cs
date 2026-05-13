// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
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

	private sealed class HostedServiceMarker;
}
