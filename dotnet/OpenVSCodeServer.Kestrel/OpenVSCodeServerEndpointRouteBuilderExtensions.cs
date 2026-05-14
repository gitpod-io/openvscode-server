// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Text.Json;
using System.Text.Json.Serialization;
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
	public static IOpenVSCodeServerEndpointBuilder MapOpenVSCodeServer(
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

		var inner = endpoints.MapMethods(
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

		return new OpenVSCodeServerEndpointBuilder(endpoints, inner);
	}

	/// <summary>
	/// Adds the session-management HTTP endpoints under <paramref name="pathPrefix"/>:
	/// <list type="bullet">
	///   <item><c>POST {prefix}</c> — creates a new session, runs
	///   <see cref="IVSCodeFiles.InitializeAsync"/>, and returns
	///   <c>{ sessionId, workspaceFolder, ideUrl }</c>.</item>
	///   <item><c>GET {prefix}/{id}</c> — returns the same metadata for a live session, or 404.</item>
	///   <item><c>DELETE {prefix}/{id}</c> — flushes pending changes, runs a final
	///   <see cref="IVSCodeFiles.SaveAsync"/>, removes the temp folder, and returns 204. Returns
	///   404 if no such session exists.</item>
	/// </list>
	/// <para>The <c>ideUrl</c> in the response is built from the prefix passed to the first
	/// <see cref="MapOpenVSCodeServer"/> call, with a <c>?folder=</c> query string pointing at the
	/// session's temporary workspace folder. Make sure <see cref="MapOpenVSCodeServer"/> is called
	/// before this method so the canonical mount prefix is known.</para>
	/// <para>Throws at request time if no <see cref="IVSCodeFiles"/> implementation was registered
	/// via <see cref="OpenVSCodeServerServiceCollectionExtensions.AddVSCodeFiles{T}"/>.</para>
	/// </summary>
	public static IEndpointConventionBuilder MapOpenVSCodeServerSessions(
		this IEndpointRouteBuilder endpoints,
		string pathPrefix = "/sessions")
	{
		ArgumentNullException.ThrowIfNull(endpoints);
		ArgumentException.ThrowIfNullOrEmpty(pathPrefix);

		pathPrefix = NormalizePathPrefix(pathPrefix);
		var basePath = pathPrefix == "/" ? string.Empty : pathPrefix;

		var group = endpoints.MapGroup(basePath);

		group.MapPost("/", CreateSessionAsync)
			.WithDisplayName("OpenVSCode Server – create session");

		group.MapGet("/{sessionId}", GetSession)
			.WithDisplayName("OpenVSCode Server – get session");

		group.MapPost("/{sessionId}/heartbeat", HeartbeatSession)
			.WithDisplayName("OpenVSCode Server – heartbeat session");

		group.MapDelete("/{sessionId}", EndSessionAsync)
			.WithDisplayName("OpenVSCode Server – end session");

		return group;
	}

	private static IResult HeartbeatSession(
		string sessionId,
		VSCodeSessionManager manager)
	{
		var session = manager.Get(sessionId);
		if (session is null)
		{
			return Results.NotFound();
		}

		session.Touch();
		return Results.NoContent();
	}

	private static async Task<IResult> CreateSessionAsync(
		HttpContext context,
		VSCodeSessionManager manager,
		IOptions<OpenVSCodeServerOptions> opts)
	{
		CreateSessionRequest? body = null;
		if (context.Request.ContentLength > 0
			|| (context.Request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) ?? false))
		{
			try
			{
				body = await context.Request.ReadFromJsonAsync<CreateSessionRequest>(
					SessionJson.Options, context.RequestAborted).ConfigureAwait(false);
			}
			catch (JsonException ex)
			{
				return Results.BadRequest(new { error = "invalid_json", message = ex.Message });
			}
		}

		var session = await manager.CreateAsync(body?.State, context.RequestAborted).ConfigureAwait(false);

		return Results.Json(BuildResponse(session, opts.Value), SessionJson.Options, statusCode: StatusCodes.Status201Created);
	}

	private static IResult GetSession(
		string sessionId,
		VSCodeSessionManager manager,
		IOptions<OpenVSCodeServerOptions> opts)
	{
		var session = manager.Get(sessionId);
		if (session is null)
		{
			return Results.NotFound();
		}

		// Treat a GET as activity so polling clients keep their session alive.
		session.Touch();
		return Results.Json(BuildResponse(session, opts.Value), SessionJson.Options);
	}

	private static async Task<IResult> EndSessionAsync(
		string sessionId,
		HttpContext context,
		VSCodeSessionManager manager)
	{
		var removed = await manager.EndAsync(sessionId, context.RequestAborted).ConfigureAwait(false);
		return removed ? Results.NoContent() : Results.NotFound();
	}

	private static CreateSessionResponse BuildResponse(VSCodeSession session, OpenVSCodeServerOptions options)
	{
		var mount = options.PathPrefix is { Length: > 0 } prefix ? prefix : "/";
		var ideBase = mount == "/" ? "/" : mount + "/";
		var ideUrl = ideBase + "?folder=" + Uri.EscapeDataString(session.WorkspaceFolder);
		return new CreateSessionResponse(session.SessionId, session.WorkspaceFolder, ideUrl);
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

	private sealed record CreateSessionRequest(
		[property: JsonPropertyName("state")] Dictionary<string, string>? State);

	private sealed record CreateSessionResponse(
		[property: JsonPropertyName("sessionId")] string SessionId,
		[property: JsonPropertyName("workspaceFolder")] string WorkspaceFolder,
		[property: JsonPropertyName("ideUrl")] string IdeUrl);

	private static class SessionJson
	{
		public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
		{
			DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
		};
	}
}
