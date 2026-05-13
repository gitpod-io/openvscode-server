// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Diagnostics.Metrics;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class MetricsTests
{
	[Fact]
	public void RecordHttpRequest_EmitsCounterAndHistogram()
	{
		using var metrics = new OpenVSCodeServerMetrics("OpenVSCodeServer.Tests.Metrics1");
		using var sink = new MetricSink("OpenVSCodeServer.Tests.Metrics1");

		metrics.RecordHttpRequest(200, durationMs: 12.5);
		metrics.RecordHttpRequest(502, durationMs: 0.5);

		var counter = sink.Snapshot("openvscode_server.proxy.http_requests");
		Assert.Equal(2, SumOf(counter));
		Assert.Contains(counter, m =>
			m.Tags.TryGetValue("http.response.status_code", out var v)
			&& v is int i && i == 200);

		var histogram = sink.Snapshot("openvscode_server.proxy.http_duration");
		Assert.Equal(2, histogram.Count);
		Assert.Contains(histogram, m => m.Value is double d && Math.Abs(d - 12.5) < 1e-9);
	}

	[Fact]
	public void RecordChildRestart_EmitsCounter()
	{
		using var metrics = new OpenVSCodeServerMetrics("OpenVSCodeServer.Tests.Metrics2");
		using var sink = new MetricSink("OpenVSCodeServer.Tests.Metrics2");

		metrics.RecordChildRestart();
		metrics.RecordChildRestart();

		Assert.Equal(2, SumOf(sink.Snapshot("openvscode_server.process.restarts")));
	}

	[Fact]
	public void TrackWebSocket_IncrementsAndDecrementsGauge()
	{
		using var metrics = new OpenVSCodeServerMetrics("OpenVSCodeServer.Tests.Metrics3");
		using var sink = new MetricSink("OpenVSCodeServer.Tests.Metrics3");

		var scope1 = metrics.TrackWebSocket();
		var scope2 = metrics.TrackWebSocket();
		scope1.Dispose();

		// websocket_connections is a Counter: 2 hits → sum 2.
		// websocket_active is an UpDownCounter: +1 +1 -1 = +1 net.
		Assert.Equal(2, SumOf(sink.Snapshot("openvscode_server.proxy.websocket_connections")));
		Assert.Equal(1, SumOf(sink.Snapshot("openvscode_server.proxy.websocket_active")));

		scope2.Dispose();

		Assert.Equal(0, SumOf(sink.Snapshot("openvscode_server.proxy.websocket_active")));
	}

	private static double SumOf(IReadOnlyList<Measurement> measurements)
	{
		double total = 0;
		foreach (var m in measurements)
		{
			total += m.Value switch
			{
				long l => l,
				int i => i,
				double d => d,
				_ => 0,
			};
		}
		return total;
	}

	private sealed record Measurement(object Value, IReadOnlyDictionary<string, object?> Tags);

	private sealed class MetricSink : IDisposable
	{
		private readonly MeterListener _listener;
		private readonly Dictionary<string, List<Measurement>> _measurements = new(StringComparer.Ordinal);
		private readonly object _lock = new();

		public MetricSink(string meterName)
		{
			_listener = new MeterListener
			{
				InstrumentPublished = (instrument, listener) =>
				{
					if (instrument.Meter.Name == meterName)
					{
						listener.EnableMeasurementEvents(instrument);
					}
				},
			};
			_listener.SetMeasurementEventCallback<long>(OnLong);
			_listener.SetMeasurementEventCallback<double>(OnDouble);
			_listener.Start();
		}

		public IReadOnlyList<Measurement> Snapshot(string instrument)
		{
			lock (_lock)
			{
				return _measurements.TryGetValue(instrument, out var values)
					? values.ToArray()
					: Array.Empty<Measurement>();
			}
		}

		private void OnLong(Instrument instrument, long value, ReadOnlySpan<KeyValuePair<string, object?>> tags, object? state)
			=> Record(instrument.Name, value, tags);

		private void OnDouble(Instrument instrument, double value, ReadOnlySpan<KeyValuePair<string, object?>> tags, object? state)
			=> Record(instrument.Name, value, tags);

		private void Record(string name, object value, ReadOnlySpan<KeyValuePair<string, object?>> tags)
		{
			var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
			foreach (var kv in tags)
			{
				dict[kv.Key] = kv.Value;
			}
			lock (_lock)
			{
				if (!_measurements.TryGetValue(name, out var list))
				{
					list = new List<Measurement>();
					_measurements[name] = list;
				}
				list.Add(new Measurement(value, dict));
			}
		}

		public void Dispose() => _listener.Dispose();
	}
}
