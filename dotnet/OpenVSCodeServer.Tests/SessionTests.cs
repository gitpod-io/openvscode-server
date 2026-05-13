// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class SessionTests
{
	[Fact]
	public async Task CreateAsync_runs_initialize_with_empty_folder()
	{
		await using var sp = BuildServices();
		var manager = sp.GetRequiredService<VSCodeSessionManager>();

		var stub = sp.GetRequiredService<RecordingVSCodeFiles>();
		stub.OnInitialize = (ctx, _) =>
		{
			Assert.True(Directory.Exists(ctx.WorkspaceFolder));
			Assert.Empty(Directory.GetFileSystemEntries(ctx.WorkspaceFolder));
			Assert.False(string.IsNullOrWhiteSpace(ctx.SessionId));
			File.WriteAllText(Path.Combine(ctx.WorkspaceFolder, "README.md"), "hello");
			return Task.CompletedTask;
		};

		var session = await manager.CreateAsync(state: null, CancellationToken.None);

		Assert.Equal(1, stub.InitializeCalls);
		Assert.True(File.Exists(Path.Combine(session.WorkspaceFolder, "README.md")));
	}

	[Fact]
	public async Task File_modification_after_initialize_triggers_save_with_relative_path()
	{
		await using var sp = BuildServices(saveDebounce: TimeSpan.FromMilliseconds(100));
		var manager = sp.GetRequiredService<VSCodeSessionManager>();
		var stub = sp.GetRequiredService<RecordingVSCodeFiles>();

		stub.OnInitialize = (ctx, _) =>
		{
			Directory.CreateDirectory(Path.Combine(ctx.WorkspaceFolder, "src"));
			File.WriteAllText(Path.Combine(ctx.WorkspaceFolder, "src", "hello.txt"), "initial");
			return Task.CompletedTask;
		};

		var session = await manager.CreateAsync(state: null, CancellationToken.None);

		// Edit a file inside the session folder; the watcher should fire and the debouncer should
		// hand a Modified change to SaveAsync.
		File.WriteAllText(Path.Combine(session.WorkspaceFolder, "src", "hello.txt"), "edited");

		var batch = await stub.NextSaveAsync(TimeSpan.FromSeconds(5));
		var change = Assert.Single(batch);
		Assert.Equal("src/hello.txt", change.RelativePath);
		Assert.True(change.Kind is VSCodeFileChangeKind.Modified or VSCodeFileChangeKind.Created,
			$"Expected Modified or Created, got {change.Kind}.");
	}

	[Fact]
	public async Task EndAsync_runs_final_save_and_removes_folder()
	{
		await using var sp = BuildServices(saveDebounce: TimeSpan.FromSeconds(30));
		var manager = sp.GetRequiredService<VSCodeSessionManager>();
		var stub = sp.GetRequiredService<RecordingVSCodeFiles>();

		var session = await manager.CreateAsync(state: null, CancellationToken.None);
		var folder = session.WorkspaceFolder;
		File.WriteAllText(Path.Combine(folder, "new.txt"), "x");
		await WaitForChangeAsync(session);

		// Don't wait for the debounce — we expect EndAsync to drain pending events before
		// returning so the consumer always sees a final SaveAsync.
		var removed = await manager.EndAsync(session.SessionId, CancellationToken.None);

		Assert.True(removed);
		Assert.False(Directory.Exists(folder));
		Assert.True(stub.SaveCalls >= 1, "Expected SaveAsync to be called at least once during EndAsync.");
		Assert.Null(manager.Get(session.SessionId));
	}

	[Fact]
	public async Task State_dictionary_is_passed_through_to_initialize_and_save()
	{
		await using var sp = BuildServices(saveDebounce: TimeSpan.FromMilliseconds(100));
		var manager = sp.GetRequiredService<VSCodeSessionManager>();
		var stub = sp.GetRequiredService<RecordingVSCodeFiles>();

		var state = new Dictionary<string, string>(StringComparer.Ordinal)
		{
			["tenant"] = "acme",
			["docId"] = "doc-1",
		};

		var session = await manager.CreateAsync(state, CancellationToken.None);

		Assert.Equal("acme", session.Context.State["tenant"]);
		Assert.Equal("doc-1", session.Context.State["docId"]);

		File.WriteAllText(Path.Combine(session.WorkspaceFolder, "f.txt"), "y");
		await stub.NextSaveAsync(TimeSpan.FromSeconds(5));

		Assert.Equal("acme", stub.LastSaveContext!.State["tenant"]);
	}

	[Fact]
	public async Task Manager_dispose_flushes_all_active_sessions()
	{
		await using var sp = BuildServices(saveDebounce: TimeSpan.FromSeconds(30));
		var manager = sp.GetRequiredService<VSCodeSessionManager>();
		var stub = sp.GetRequiredService<RecordingVSCodeFiles>();

		var session = await manager.CreateAsync(state: null, CancellationToken.None);
		var folder = session.WorkspaceFolder;
		File.WriteAllText(Path.Combine(folder, "dirty.txt"), "data");

		// Give the FileSystemWatcher a moment to record the change. The dispose path drains any
		// pending events synchronously before deleting the folder, but it can't see events that
		// haven't been queued yet.
		await WaitForChangeAsync(session);

		await manager.StopAsync(CancellationToken.None);

		Assert.True(stub.SaveCalls >= 1);
		Assert.False(Directory.Exists(folder));
	}

	[Fact]
	public async Task Http_create_get_delete_round_trip()
	{
		var port = AllocateFreePort();
		var builder = WebApplication.CreateBuilder();
		builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
		{
			["Kestrel:Endpoints:Http:Url"] = $"http://127.0.0.1:{port}",
		});
		builder.Logging.SetMinimumLevel(LogLevel.Warning);

		// Pre-set the mount prefix on the options so the IDE URL is correctly built without us
		// having to actually boot the upstream Node process for this test.
		builder.Services.AddOptions<OpenVSCodeServerOptions>().Configure(o =>
		{
			o.PathPrefix = "/ide";
			o.PathPrefixSet = true;
			o.Sessions.SaveDebounce = TimeSpan.FromMilliseconds(50);
		});
		builder.Services.AddSingleton<RecordingVSCodeFiles>();
		builder.Services.AddVSCodeFiles<RecordingVSCodeFiles>();
		// AddVSCodeFiles registers IVSCodeFiles as scoped; bridge it to the singleton instance so
		// the test can inspect the call history.
		builder.Services.AddScoped<IVSCodeFiles>(sp => sp.GetRequiredService<RecordingVSCodeFiles>());

		using var app = builder.Build();
		app.MapOpenVSCodeServerSessions("/sessions");
		await app.StartAsync();
		try
		{
			using var http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };

			// Create
			var createResp = await http.PostAsJsonAsync("/sessions", new
			{
				state = new { tenant = "acme" },
			});
			Assert.Equal(HttpStatusCode.Created, createResp.StatusCode);

			var created = await createResp.Content.ReadFromJsonAsync<JsonElement>();
			var sessionId = created.GetProperty("sessionId").GetString();
			var workspaceFolder = created.GetProperty("workspaceFolder").GetString();
			var ideUrl = created.GetProperty("ideUrl").GetString();

			Assert.False(string.IsNullOrEmpty(sessionId));
			Assert.True(Directory.Exists(workspaceFolder));
			Assert.NotNull(ideUrl);
			Assert.StartsWith("/ide/?folder=", ideUrl);
			Assert.Contains(Uri.EscapeDataString(workspaceFolder!), ideUrl);

			// Get
			var getResp = await http.GetAsync($"/sessions/{sessionId}");
			Assert.Equal(HttpStatusCode.OK, getResp.StatusCode);
			var fetched = await getResp.Content.ReadFromJsonAsync<JsonElement>();
			Assert.Equal(sessionId, fetched.GetProperty("sessionId").GetString());

			// Delete
			var deleteResp = await http.DeleteAsync($"/sessions/{sessionId}");
			Assert.Equal(HttpStatusCode.NoContent, deleteResp.StatusCode);
			Assert.False(Directory.Exists(workspaceFolder));

			// Subsequent get → 404
			var missingResp = await http.GetAsync($"/sessions/{sessionId}");
			Assert.Equal(HttpStatusCode.NotFound, missingResp.StatusCode);
		}
		finally
		{
			await app.StopAsync();
		}
	}

	[Fact]
	public async Task Http_delete_returns_404_for_unknown_session()
	{
		var port = AllocateFreePort();
		var builder = WebApplication.CreateBuilder();
		builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
		{
			["Kestrel:Endpoints:Http:Url"] = $"http://127.0.0.1:{port}",
		});
		builder.Logging.SetMinimumLevel(LogLevel.Warning);

		builder.Services.AddSingleton<RecordingVSCodeFiles>();
		builder.Services.AddVSCodeFiles<RecordingVSCodeFiles>();
		builder.Services.AddScoped<IVSCodeFiles>(sp => sp.GetRequiredService<RecordingVSCodeFiles>());

		using var app = builder.Build();
		app.MapOpenVSCodeServerSessions("/sessions");
		await app.StartAsync();
		try
		{
			using var http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
			var resp = await http.DeleteAsync("/sessions/does-not-exist");
			Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
		}
		finally
		{
			await app.StopAsync();
		}
	}

	private static ServiceProvider BuildServices(TimeSpan? saveDebounce = null)
	{
		var services = new ServiceCollection();
		services.AddLogging(b => b.SetMinimumLevel(LogLevel.Warning));
		services.AddSingleton<RecordingVSCodeFiles>();
		services.AddVSCodeFiles<RecordingVSCodeFiles>();
		// The scoped registration that AddVSCodeFiles produces would build a new instance per
		// scope; bridge it to the singleton so the test can introspect.
		services.AddScoped<IVSCodeFiles>(sp => sp.GetRequiredService<RecordingVSCodeFiles>());

		var debounce = saveDebounce ?? TimeSpan.FromMilliseconds(100);
		services.Configure<OpenVSCodeServerOptions>(o =>
		{
			o.Sessions.SaveDebounce = debounce;
			o.Sessions.RootDirectory = Path.Combine(Path.GetTempPath(),
				"openvscode-tests-" + Guid.NewGuid().ToString("N"));
		});

		return services.BuildServiceProvider();
	}

	private static async Task WaitForChangeAsync(VSCodeSession session, TimeSpan? timeout = null)
	{
		var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
		while (session.PendingChangeCount == 0)
		{
			if (DateTime.UtcNow > deadline)
			{
				throw new TimeoutException(
					"FileSystemWatcher did not record any pending change before the test deadline.");
			}
			await Task.Delay(25);
		}
	}

	private static int AllocateFreePort()
	{
		using var listener = new TcpListener(IPAddress.Loopback, 0);
		listener.Start();
		try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
		finally { listener.Stop(); }
	}

	private sealed class RecordingVSCodeFiles : IVSCodeFiles
	{
		private readonly Channel<IReadOnlyCollection<VSCodeFileChange>> _saves =
			Channel.CreateUnbounded<IReadOnlyCollection<VSCodeFileChange>>();

		public Func<VSCodeSessionContext, CancellationToken, Task>? OnInitialize { get; set; }

		public int InitializeCalls;
		public int SaveCalls;
		public VSCodeSessionContext? LastSaveContext;

		public Task InitializeAsync(VSCodeSessionContext context, CancellationToken cancellationToken)
		{
			Interlocked.Increment(ref InitializeCalls);
			return OnInitialize?.Invoke(context, cancellationToken) ?? Task.CompletedTask;
		}

		public Task SaveAsync(
			VSCodeSessionContext context,
			IReadOnlyCollection<VSCodeFileChange> changes,
			CancellationToken cancellationToken)
		{
			Interlocked.Increment(ref SaveCalls);
			LastSaveContext = context;
			_saves.Writer.TryWrite(changes);
			return Task.CompletedTask;
		}

		public async Task<IReadOnlyCollection<VSCodeFileChange>> NextSaveAsync(TimeSpan timeout)
		{
			using var cts = new CancellationTokenSource(timeout);
			try
			{
				return await _saves.Reader.ReadAsync(cts.Token);
			}
			catch (OperationCanceledException)
			{
				throw new TimeoutException(
					$"Expected an IVSCodeFiles.SaveAsync call within {timeout.TotalSeconds:N1}s but none arrived.");
			}
		}
	}
}
