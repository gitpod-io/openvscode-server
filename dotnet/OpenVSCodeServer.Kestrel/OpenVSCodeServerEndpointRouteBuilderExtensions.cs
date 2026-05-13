// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Endpoint-routing helpers for mounting the embedded OpenVSCode Server inside a Kestrel pipeline.
/// </summary>
public static class OpenVSCodeServerEndpointRouteBuilderExtensions
{
	/// <summary>
	/// Mounts the OpenVSCode Server reverse proxy at <paramref name="pathPrefix"/>. All HTTP and
	/// WebSocket traffic underneath the prefix is forwarded to the embedded server.
	/// </summary>
	public static IEndpointConventionBuilder MapOpenVSCodeServer(
		this IEndpointRouteBuilder endpoints,
		string pathPrefix = "/")
	{
		ArgumentNullException.ThrowIfNull(endpoints);
		ArgumentException.ThrowIfNullOrEmpty(pathPrefix);

		if (!pathPrefix.StartsWith('/'))
		{
			pathPrefix = "/" + pathPrefix;
		}
		pathPrefix = pathPrefix.TrimEnd('/');
		if (string.IsNullOrEmpty(pathPrefix))
		{
			pathPrefix = "/";
		}

		// The child server needs to know the prefix so its self-emitted absolute URLs
		// (server-base-path) remain valid behind the Kestrel mount.
		var options = endpoints.ServiceProvider.GetRequiredService<IOptions<OpenVSCodeServerOptions>>().Value;
		options.PathPrefix = pathPrefix;

		var route = pathPrefix == "/" ? "/{**catchall}" : pathPrefix + "/{**catchall}";

		return endpoints.MapMethods(
			route,
			new[] { "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" },
			static async (HttpContext context, OpenVSCodeServerProxy proxy) =>
			{
				var prefix = context.RequestServices
					.GetRequiredService<IOptions<OpenVSCodeServerOptions>>().Value.PathPrefix;
				var prefixPath = prefix == "/" ? PathString.Empty : new PathString(prefix);
				await proxy.HandleAsync(context, prefixPath);
			})
			.WithDisplayName("OpenVSCode Server");
	}
}
