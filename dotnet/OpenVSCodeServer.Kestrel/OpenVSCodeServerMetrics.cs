// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Application-side instrumentation for the OpenVSCode Server integration. Emits standard
/// <see cref="System.Diagnostics.Metrics"/> signals under the <c>OpenVSCodeServer.Kestrel</c>
/// meter so any <see cref="MeterListener"/> (or an OpenTelemetry exporter) can collect them.
/// </summary>
internal sealed class OpenVSCodeServerMetrics : IDisposable
{
	/// <summary>Meter name exposed to <see cref="MeterListener"/> consumers.</summary>
	public const string MeterName = "OpenVSCodeServer.Kestrel";

	private readonly Meter _meter;
	private readonly Counter<long> _httpRequests;
	private readonly Counter<long> _webSocketConnections;
	private readonly Counter<long> _childRestarts;
	private readonly UpDownCounter<long> _activeWebSockets;
	private readonly Histogram<double> _httpDurationMs;

	public OpenVSCodeServerMetrics()
		: this(MeterName)
	{
	}

	internal OpenVSCodeServerMetrics(string meterName)
	{
		_meter = new Meter(meterName, "1.0.0");

		_httpRequests = _meter.CreateCounter<long>(
			"openvscode_server.proxy.http_requests",
			unit: "{request}",
			description: "Number of HTTP requests proxied to the embedded openvscode-server child.");

		_webSocketConnections = _meter.CreateCounter<long>(
			"openvscode_server.proxy.websocket_connections",
			unit: "{connection}",
			description: "Number of WebSocket upgrades proxied to the embedded openvscode-server child.");

		_activeWebSockets = _meter.CreateUpDownCounter<long>(
			"openvscode_server.proxy.websocket_active",
			unit: "{connection}",
			description: "Number of currently-open proxied WebSocket connections.");

		_childRestarts = _meter.CreateCounter<long>(
			"openvscode_server.process.restarts",
			unit: "{restart}",
			description: "Number of times the embedded openvscode-server child process has been restarted after a crash.");

		_httpDurationMs = _meter.CreateHistogram<double>(
			"openvscode_server.proxy.http_duration",
			unit: "ms",
			description: "Wall-clock duration of proxied HTTP requests.");
	}

	public void RecordHttpRequest(int statusCode, double durationMs)
	{
		var statusBucket = statusCode / 100;
		var tags = new TagList
		{
			{ "http.response.status_code", statusCode },
			{ "http.response.status_class", $"{statusBucket}xx" },
		};
		_httpRequests.Add(1, tags);
		_httpDurationMs.Record(durationMs, tags);
	}

	public void RecordHttpFailure()
	{
		var tags = new TagList { { "http.response.status_class", "5xx" } };
		_httpRequests.Add(1, tags);
	}

	public IDisposable TrackWebSocket()
	{
		_webSocketConnections.Add(1);
		_activeWebSockets.Add(1);
		return new WebSocketScope(_activeWebSockets);
	}

	public void RecordChildRestart() => _childRestarts.Add(1);

	public void Dispose() => _meter.Dispose();

	private sealed class WebSocketScope : IDisposable
	{
		private UpDownCounter<long>? _gauge;

		public WebSocketScope(UpDownCounter<long> gauge) => _gauge = gauge;

		public void Dispose()
		{
			var gauge = Interlocked.Exchange(ref _gauge, null);
			gauge?.Add(-1);
		}
	}
}
