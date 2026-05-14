// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Fluent builder returned by
/// <see cref="OpenVSCodeServerEndpointRouteBuilderExtensions.MapOpenVSCodeServer"/>. Exposes the
/// usual <see cref="IEndpointConventionBuilder"/> surface and adds a <see cref="WithSessions"/>
/// shortcut so callers can register the proxy and the session HTTP API in one chain.
/// </summary>
public interface IOpenVSCodeServerEndpointBuilder : IEndpointConventionBuilder
{
	/// <summary>
	/// Mounts the per-request session endpoints under <paramref name="pathPrefix"/>. Equivalent
	/// to calling
	/// <see cref="OpenVSCodeServerEndpointRouteBuilderExtensions.MapOpenVSCodeServerSessions"/>
	/// directly on the original <see cref="IEndpointRouteBuilder"/>, but lets callers fluently
	/// chain it off <see cref="OpenVSCodeServerEndpointRouteBuilderExtensions.MapOpenVSCodeServer"/>
	/// so they don't have to remember the two methods are paired.
	/// </summary>
	IOpenVSCodeServerEndpointBuilder WithSessions(string pathPrefix = "/sessions");
}

internal sealed class OpenVSCodeServerEndpointBuilder : IOpenVSCodeServerEndpointBuilder
{
	private readonly IEndpointRouteBuilder _endpoints;
	private readonly IEndpointConventionBuilder _inner;

	public OpenVSCodeServerEndpointBuilder(IEndpointRouteBuilder endpoints, IEndpointConventionBuilder inner)
	{
		_endpoints = endpoints;
		_inner = inner;
	}

	public void Add(Action<EndpointBuilder> convention) => _inner.Add(convention);

	public void Finally(Action<EndpointBuilder> finallyConvention) => _inner.Finally(finallyConvention);

	public IOpenVSCodeServerEndpointBuilder WithSessions(string pathPrefix = "/sessions")
	{
		_endpoints.MapOpenVSCodeServerSessions(pathPrefix);
		return this;
	}
}
