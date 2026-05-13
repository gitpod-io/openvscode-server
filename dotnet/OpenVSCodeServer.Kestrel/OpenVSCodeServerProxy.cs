// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Net;
using System.Net.WebSockets;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Forwards incoming HTTP and WebSocket traffic to the embedded openvscode-server child process.
/// </summary>
internal sealed class OpenVSCodeServerProxy : IAsyncDisposable
{
	private static readonly HashSet<string> HopByHopRequestHeaders =
		new(StringComparer.OrdinalIgnoreCase)
		{
			"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
			"TE", "Trailers", "Transfer-Encoding", "Upgrade", "Host",
		};

	private static readonly HashSet<string> HopByHopResponseHeaders =
		new(StringComparer.OrdinalIgnoreCase)
		{
			"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
			"TE", "Trailers", "Transfer-Encoding", "Upgrade",
		};

	private readonly ILogger<OpenVSCodeServerProxy> _logger;
	private readonly OpenVSCodeServerProcess _process;
	private readonly HttpMessageInvoker _httpClient;

	public OpenVSCodeServerProxy(
		ILogger<OpenVSCodeServerProxy> logger,
		OpenVSCodeServerProcess process)
	{
		_logger = logger;
		_process = process;
		_httpClient = new HttpMessageInvoker(new SocketsHttpHandler
		{
			AllowAutoRedirect = false,
			UseCookies = false,
			AutomaticDecompression = DecompressionMethods.None,
			ConnectTimeout = TimeSpan.FromSeconds(15),
			PooledConnectionLifetime = TimeSpan.FromMinutes(5),
		});
	}

	public ValueTask DisposeAsync()
	{
		_httpClient.Dispose();
		return ValueTask.CompletedTask;
	}

	public async Task HandleAsync(HttpContext context, PathString pathPrefix)
	{
		var upstream = await _process.ReadyUri.ConfigureAwait(false);
		var token = _process.ResolvedConnectionToken;

		if (context.WebSockets.IsWebSocketRequest)
		{
			await ProxyWebSocketAsync(context, upstream, pathPrefix, token).ConfigureAwait(false);
			return;
		}

		await ProxyHttpAsync(context, upstream, pathPrefix, token).ConfigureAwait(false);
	}

	private async Task ProxyHttpAsync(HttpContext context, Uri upstreamRoot, PathString pathPrefix, string? connectionToken)
	{
		var targetUri = BuildUpstreamUri(upstreamRoot, context.Request, pathPrefix, websocket: false, connectionToken);

		using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), targetUri);

		var hasBody = HttpMethods.IsPost(context.Request.Method)
			|| HttpMethods.IsPut(context.Request.Method)
			|| HttpMethods.IsPatch(context.Request.Method)
			|| HttpMethods.IsDelete(context.Request.Method);
		if (hasBody)
		{
			request.Content = new StreamContent(context.Request.Body);
		}

		foreach (var header in context.Request.Headers)
		{
			if (HopByHopRequestHeaders.Contains(header.Key))
			{
				continue;
			}

			if (!request.Headers.TryAddWithoutValidation(header.Key, (IEnumerable<string?>)header.Value))
			{
				request.Content?.Headers.TryAddWithoutValidation(header.Key, (IEnumerable<string?>)header.Value);
			}
		}

		// Forward the original host so the IDE can produce accurate self-links if it needs to.
		request.Headers.TryAddWithoutValidation("X-Forwarded-Host", context.Request.Host.Value);
		request.Headers.TryAddWithoutValidation(
			"X-Forwarded-Proto", context.Request.Scheme);
		if (context.Connection.RemoteIpAddress is { } remote)
		{
			request.Headers.TryAddWithoutValidation("X-Forwarded-For", remote.ToString());
		}

		HttpResponseMessage upstream;
		try
		{
			upstream = await _httpClient.SendAsync(request, context.RequestAborted).ConfigureAwait(false);
		}
		catch (HttpRequestException ex) when (!context.RequestAborted.IsCancellationRequested)
		{
			_logger.LogError(ex, "Upstream request to openvscode-server failed: {Uri}", targetUri);
			context.Response.StatusCode = StatusCodes.Status502BadGateway;
			return;
		}

		using (upstream)
		{
			context.Response.StatusCode = (int)upstream.StatusCode;

			foreach (var header in upstream.Headers)
			{
				if (HopByHopResponseHeaders.Contains(header.Key))
				{
					continue;
				}
				context.Response.Headers[header.Key] = header.Value.ToArray();
			}

			foreach (var header in upstream.Content.Headers)
			{
				if (HopByHopResponseHeaders.Contains(header.Key))
				{
					continue;
				}
				context.Response.Headers[header.Key] = header.Value.ToArray();
			}

			context.Response.Headers.Remove("transfer-encoding");

			await upstream.Content
				.CopyToAsync(context.Response.Body, context.RequestAborted)
				.ConfigureAwait(false);
		}
	}

	private async Task ProxyWebSocketAsync(HttpContext context, Uri upstreamRoot, PathString pathPrefix, string? connectionToken)
	{
		using var clientSocket = new ClientWebSocket();

		// Forward the WebSocket sub-protocols requested by the browser, if any.
		foreach (var proto in context.WebSockets.WebSocketRequestedProtocols)
		{
			clientSocket.Options.AddSubProtocol(proto);
		}

		// Mirror headers (cookies in particular) onto the outgoing WebSocket handshake.
		foreach (var header in context.Request.Headers)
		{
			if (HopByHopRequestHeaders.Contains(header.Key)
				|| header.Key.StartsWith("Sec-WebSocket-", StringComparison.OrdinalIgnoreCase))
			{
				continue;
			}

			try
			{
				clientSocket.Options.SetRequestHeader(header.Key, header.Value.ToString());
			}
			catch (ArgumentException)
			{
				// Some restricted headers cannot be set on ClientWebSocketOptions; skip silently.
			}
		}

		var wsUri = BuildUpstreamUri(upstreamRoot, context.Request, pathPrefix, websocket: true, connectionToken);

		try
		{
			await clientSocket.ConnectAsync(wsUri, context.RequestAborted).ConfigureAwait(false);
		}
		catch (Exception ex)
		{
			_logger.LogError(ex, "WebSocket connect to upstream failed: {Uri}", wsUri);
			context.Response.StatusCode = StatusCodes.Status502BadGateway;
			return;
		}

		using var serverSocket = await context.WebSockets
			.AcceptWebSocketAsync(clientSocket.SubProtocol)
			.ConfigureAwait(false);

		await Task.WhenAll(
			PumpAsync(serverSocket, clientSocket, context.RequestAborted),
			PumpAsync(clientSocket, serverSocket, context.RequestAborted))
			.ConfigureAwait(false);
	}

	internal static Uri BuildUpstreamUri(Uri upstreamRoot, HttpRequest request, PathString pathPrefix, bool websocket, string? connectionToken = null)
	{
		// Strip the Kestrel-mount prefix so the upstream server (which serves at the root) sees a
		// canonical path it understands. The child server is started with --server-base-path so
		// any URLs it emits already include the prefix.
		var path = request.Path.Value ?? string.Empty;
		if (pathPrefix.HasValue && path.StartsWith(pathPrefix.Value!, StringComparison.Ordinal))
		{
			path = path[pathPrefix.Value!.Length..];
		}
		if (string.IsNullOrEmpty(path))
		{
			path = "/";
		}

		var query = request.QueryString.Value ?? string.Empty;
		if (query.StartsWith('?'))
		{
			query = query[1..];
		}
		query = MergeConnectionToken(query, connectionToken);

		var builder = new UriBuilder(upstreamRoot)
		{
			Path = pathPrefix.HasValue ? pathPrefix.Value + (path == "/" ? string.Empty : path) : path,
			Query = query,
		};

		if (websocket)
		{
			builder.Scheme = upstreamRoot.Scheme == "https" ? "wss" : "ws";
		}

		return builder.Uri;
	}

	/// <summary>
	/// Ensures the connection token (when configured) is present in the upstream query string,
	/// without duplicating an existing one. Public-internal so tests can poke at it.
	/// </summary>
	internal static string MergeConnectionToken(string query, string? connectionToken)
	{
		if (string.IsNullOrEmpty(connectionToken))
		{
			return query;
		}

		// Upstream openvscode-server reads the token from the "tkn" query parameter.
		const string tokenKey = "tkn";

		if (HasQueryKey(query, tokenKey))
		{
			// Overwrite any caller-supplied value so the parent app stays the source of truth.
			query = StripQueryKey(query, tokenKey);
		}

		var encoded = Uri.EscapeDataString(connectionToken);
		return string.IsNullOrEmpty(query)
			? $"{tokenKey}={encoded}"
			: $"{query}&{tokenKey}={encoded}";
	}

	private static bool HasQueryKey(string query, string key)
	{
		foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
		{
			var equals = part.IndexOf('=');
			var partKey = equals < 0 ? part : part[..equals];
			if (string.Equals(partKey, key, StringComparison.OrdinalIgnoreCase))
			{
				return true;
			}
		}
		return false;
	}

	private static string StripQueryKey(string query, string key)
	{
		var kept = new List<string>();
		foreach (var part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
		{
			var equals = part.IndexOf('=');
			var partKey = equals < 0 ? part : part[..equals];
			if (!string.Equals(partKey, key, StringComparison.OrdinalIgnoreCase))
			{
				kept.Add(part);
			}
		}
		return string.Join('&', kept);
	}

	private static async Task PumpAsync(WebSocket source, WebSocket destination, CancellationToken cancellationToken)
	{
		var buffer = new byte[16 * 1024];
		try
		{
			while (source.State == WebSocketState.Open && destination.State == WebSocketState.Open)
			{
				WebSocketReceiveResult result;
				try
				{
					result = await source.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
				}
				catch (WebSocketException)
				{
					break;
				}
				catch (OperationCanceledException)
				{
					break;
				}

				if (result.MessageType == WebSocketMessageType.Close)
				{
					await destination.CloseOutputAsync(
						source.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
						source.CloseStatusDescription,
						CancellationToken.None).ConfigureAwait(false);
					return;
				}

				await destination.SendAsync(
					new ArraySegment<byte>(buffer, 0, result.Count),
					result.MessageType,
					result.EndOfMessage,
					cancellationToken).ConfigureAwait(false);
			}
		}
		catch (OperationCanceledException)
		{
		}
	}
}
