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
	///
	/// <para>The library hosts a single Node child process per <see cref="IServiceCollection"/>;
	/// calling this method multiple times mounts additional routes onto the same backing process.
	/// Repeat calls with the <em>same</em> prefix are idempotent. Calls with a <em>different</em>
	/// prefix are accepted, but only the first prefix is propagated to the child server as
	/// <c>--server-base-path</c> — secondary mounts work for raw API/WebSocket traffic where the
	/// browser does not need the upstream to emit absolute URLs.</para>
	/// </summary>
	public static IEndpointConventionBuilder MapOpenVSCodeServer(
		this IEndpointRouteBuilder endpoints,
		string pathPrefix = "/")
	{
		ArgumentNullException.ThrowIfNull(endpoints);
		ArgumentException.ThrowIfNullOrEmpty(pathPrefix);

		pathPrefix = NormalizePathPrefix(pathPrefix);

		var options = endpoints.ServiceProvider.GetRequiredService<IOptions<OpenVSCodeServerOptions>>().Value;

		// First call establishes the canonical prefix advertised to the child as
		// `--server-base-path`. Later calls are allowed (to share one Node child across multiple
		// mount points) but a warning surface is offered via OnAdditionalMount so callers can opt
		// into stricter behaviour.
		if (!options.PathPrefixSet)
		{
			options.PathPrefix = pathPrefix;
			options.PathPrefixSet = true;
		}
		else if (!string.Equals(options.PathPrefix, pathPrefix, StringComparison.Ordinal))
		{
			options.AdditionalMountPrefixes.Add(pathPrefix);
		}

		var route = pathPrefix == "/" ? "/{**catchall}" : pathPrefix + "/{**catchall}";
		var capturedPrefix = pathPrefix;

		return endpoints.MapMethods(
			route,
			new[] { "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" },
			async (HttpContext context, OpenVSCodeServerProxy proxy, IOptions<OpenVSCodeServerOptions> opts) =>
			{
				var inboundPrefix = capturedPrefix == "/" ? PathString.Empty : new PathString(capturedPrefix);
				// The canonical prefix is what the child server was started with as
				// --server-base-path. For the first mount this equals the inbound prefix; for
				// secondary mounts of the same backing process it differs, and the proxy must
				// rewrite paths to use the canonical one.
				var canonical = opts.Value.PathPrefix;
				var upstreamPrefix = canonical == "/" ? PathString.Empty : new PathString(canonical);
				await proxy.HandleAsync(context, inboundPrefix, upstreamPrefix);
			})
			.WithDisplayName($"OpenVSCode Server ({pathPrefix})");
	}

	private static string NormalizePathPrefix(string pathPrefix)
	{
		if (!pathPrefix.StartsWith('/'))
		{
			pathPrefix = "/" + pathPrefix;
		}
		pathPrefix = pathPrefix.TrimEnd('/');
		return string.IsNullOrEmpty(pathPrefix) ? "/" : pathPrefix;
	}
}
