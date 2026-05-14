# OpenVSCode Server for Kestrel

A .NET port that exposes the [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server) as a first-class component of an ASP.NET Core / Kestrel application.

The original openvscode-server distribution is bundled as an embedded resource (or fetched on demand). At runtime the assets are extracted to a working directory, the Node-based VS Code server is launched as a managed child process, and Kestrel reverse-proxies HTTP and WebSocket traffic to it through endpoint mappings registered on `IEndpointRouteBuilder`.

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenVSCodeServer(options =>
{
    options.WithoutConnectionToken = true;
    options.WorkspaceFolder = "/home/me/code";
});

var app = builder.Build();

app.MapOpenVSCodeServer("/ide");

app.Run();
```

`MapOpenVSCodeServer("/ide")` exposes the editor at `https://<host>/ide`. WebSockets for the remote agent protocol, language servers, and terminals are tunneled through the same Kestrel listener.

## How the library finds a distribution

`AddOpenVSCodeServer` resolves an openvscode-server install in this order at startup:

1. **`options.ExternalServerPath`** – when set, points at an existing install directory containing `out/server-main.js` and a `node` binary. The embedded asset is ignored.
2. **Embedded resource** – any `openvscode-server-*-<platform>-<arch>.tar.gz` (or `vscode-reh-web-<platform>-<arch>.tar.gz`) packed into the library by the build scripts (see below). The selector picks the closest match to the running OS / architecture, distinguishing `arm` from `arm64` and preferring `alpine-*` archives on musl-libc hosts.
3. **Runtime downloader** – opt-in via `options.Download.Enabled = true`. Fetches the configured release tarball from `https://github.com/gitpod-io/openvscode-server/releases`, verifies the gzip magic + (optionally) a pinned SHA-256, and caches it on disk for re-use.

If none of the three resolves an install, startup throws with a message pointing at the three options.

## Staging a distribution

### Download a pre-built upstream release

```bash
# Single platform/arch (defaults to the host's)
scripts/download-vscode-release.sh

# Specific build
scripts/download-vscode-release.sh --version v1.109.5 --platform linux --arch arm64

# Fetch every Linux archive (x64, arm64, armhf) in one pass
scripts/download-vscode-release.sh --all-linux

# Hash-verified
scripts/download-vscode-release.sh --sha256 <hex>
```

The PowerShell counterpart (`scripts/download-vscode-release.ps1`) takes the same arguments. Both scripts drop the tarball into `dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets/`; the `.csproj` picks it up via an `<EmbeddedResource>` glob.

### Build the distribution locally (gulp)

```bash
scripts/build-vscode-release.sh                  # current host platform
scripts/build-vscode-release.sh linux x64        # explicit platform/arch
```

The script installs the openvscode-server tree's npm dependencies, runs `npm run gulp vscode-reh-web-<platform>-<arch>-min`, and packages the gulp output into `EmbeddedAssets/`. Requires network access to `electronjs.org` for `@vscode/deviceid`'s native build step.

## Configuration

```csharp
builder.Services.AddOpenVSCodeServer(options =>
{
    options.WorkspaceFolder = "/workspaces/me";

    // Loopback binding and ephemeral port for the upstream child.
    options.Host = "127.0.0.1";
    options.Port = null;

    // Connection-token auth. When WithoutConnectionToken is false and ConnectionToken
    // is left null, a 256-bit URL-safe token is generated automatically. The proxy
    // injects ?tkn=... on every upstream request so the browser never sees it.
    options.WithoutConnectionToken = false;
    options.ConnectionToken = null;

    // Runtime downloader (opt-in).
    options.Download.Enabled = true;
    options.Download.Version = "v1.109.5";
    options.Download.Sha256 = "<expected-hex>"; // strongly recommended for prod

    // Crash recovery (default on; relaunches on the same port with exponential back-off).
    options.RestartOnCrash = true;
    options.MaxRestartAttempts = 5;
});

app.MapOpenVSCodeServer("/ide");
// Same backing Node process; secondary mounts work for raw API / WebSocket paths.
app.MapOpenVSCodeServer("/legacy-ide");
```

The full option surface lives in `OpenVSCodeServerOptions.cs`.

### Health checks

```csharp
builder.Services
    .AddHealthChecks()
    .AddOpenVSCodeServerCheck(tags: new[] { "ready" });

app.MapHealthChecks("/healthz/ready",
    new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });
```

The check returns `Healthy` once the child has emitted its "Web UI available" banner and exposes the upstream URL in the result data; it returns `Unhealthy` while the child is starting and surfaces the underlying exception on a startup failure.

## Per-session workspaces

When the host wants every visitor to see their own private workspace (a tenant-scoped sandbox, a per-document scratch folder, a CTF-style throwaway environment), register an `IVSCodeFiles` implementation that bridges the in-memory workspace folder to the host's source of truth. The library handles temp-folder lifecycle, file-watching, debounced save callbacks, idle GC, and orphan cleanup; the host implements two methods.

```csharp
public sealed class MyVSCodeFiles : IVSCodeFiles
{
    public Task InitializeAsync(VSCodeSessionContext ctx, CancellationToken ct)
    {
        // ctx.WorkspaceFolder is an empty temp folder owned by the library.
        // Populate it from durable storage (db, blob, git checkout, …).
        File.WriteAllText(Path.Combine(ctx.WorkspaceFolder, "README.md"), "hello");
        return Task.CompletedTask;
    }

    public Task SaveAsync(VSCodeSessionContext ctx,
        IReadOnlyCollection<VSCodeFileChange> changes, CancellationToken ct)
    {
        // Called on debounced FileSystemWatcher batches + once more on session end.
        // changes[i].RelativePath is forward-slash, relative to ctx.WorkspaceFolder.
        foreach (var c in changes) Console.WriteLine($"{c.Kind} {c.RelativePath}");
        return Task.CompletedTask;
    }
}
```

Wire it up alongside the proxy with the fluent `.WithSessions()` shortcut:

```csharp
builder.Services.AddOpenVSCodeServer(options =>
{
    options.WithoutConnectionToken = true;
    options.Sessions.SaveDebounce = TimeSpan.FromMilliseconds(500);
    options.Sessions.IdleTimeout  = TimeSpan.FromMinutes(30);
});

builder.Services.AddVSCodeFiles<MyVSCodeFiles>();

var app = builder.Build();

app.MapOpenVSCodeServer("/ide")
   .WithSessions("/sessions");
```

That exposes:

- `POST /sessions` → creates a session, runs `InitializeAsync`, returns `{ sessionId, workspaceFolder, ideUrl }`. The `ideUrl` is `/ide/?folder=<temp-folder>`, ready to redirect the browser to.
- `GET /sessions/{id}` → returns the same metadata for a live session (and refreshes its last-seen timestamp), or 404.
- `POST /sessions/{id}/heartbeat` → bumps the session's idle timer; useful for long-running tabs.
- `DELETE /sessions/{id}` → drains pending changes, calls `SaveAsync` one last time, deletes the temp folder, returns 204.

Sessions also self-evict after `Sessions.IdleTimeout` (default 30 min); the sweeper looks at every active session every `Sessions.IdleSweepInterval` (default 1 min) and ends any that haven't seen traffic. Proxy traffic with a matching `?folder=` query refreshes the timer automatically, so users actively editing a workbench tab don't get evicted. Set `IdleTimeout` to `TimeSpan.Zero` to disable idle GC entirely.

`CleanOrphansOnStartup` (default `true`) wipes any leftover session folders under `Sessions.RootDirectory` on host startup. This handles temp leaks from prior crashed processes — there's nothing else cleaning those folders up.

### File-watcher trade-off

The library arms a recursive `FileSystemWatcher` on each session folder so saves can be reported back without the IDE having to call out. Two caveats are worth knowing:

- **Buffer overruns.** A user pasting a huge tree (or an extension regenerating thousands of files at once) can overflow the OS watch buffer; the library logs a warning and may miss intermediate events. The final flush on `DELETE /sessions/{id}` re-walks the directory tree as a backstop for the durable save.
- **macOS / FUSE / network mounts.** `FileSystemWatcher` semantics are weaker on non-local filesystems. Set `Sessions.RootDirectory` to a local SSD-backed path; defaults to `${TEMP}/openvscode-sessions`.

If your application has a stronger source of truth than the watcher (e.g. the IDE saves through a custom protocol you already intercept), you can ignore `SaveAsync` and rely on the final flush; the temp folder still gets cleaned up regardless.

## Repository layout

```
dotnet/
    OpenVSCodeServer.Kestrel/      class library (embedded VS Code + Kestrel integration)
    OpenVSCodeServer.TestHost/     minimal Kestrel CLI host
    OpenVSCodeServer.Tests/        xUnit unit + integration tests
    OpenVSCodeServer.slnx          solution file
scripts/
    build-vscode-release.sh        local gulp build → EmbeddedAssets/
    download-vscode-release.sh     download a published release → EmbeddedAssets/
    download-vscode-release.ps1    PowerShell counterpart
src/, extensions/, build/, ...     upstream openvscode-server tree
```

The upstream openvscode-server tree is preserved so the bundled distribution can be rebuilt locally with the included script.

## Running the CLI

```bash
# 1. Stage an embedded distribution (skip if you have one already, or use --external-server-path)
scripts/download-vscode-release.sh

# 2. Launch the test host
dotnet run --project dotnet/OpenVSCodeServer.TestHost -- --workspace ~/code
```

Then open `http://127.0.0.1:5000/` in a browser. The landing page links straight into the editor at `/ide/`, where the workbench loads through the Kestrel reverse-proxy. Pass `--external-server-path`, `--path-prefix`, or the standard ASP.NET Core `--urls` flag to override defaults.

## Testing

```bash
dotnet test dotnet/OpenVSCodeServer.slnx
```

The xUnit suite covers option defaults & validation, archive selection, the runtime downloader (URL building, hash verification, caching), proxy URL rewriting, multi-mount semantics, and end-to-end hosting smoke tests that boot the workbench through Kestrel. Integration tests auto-skip when no distribution is available; opt into the live runtime-download path with `OPENVSCODE_ENABLE_DOWNLOAD_TEST=1` or point `OPENVSCODE_EXTERNAL_PATH` at an existing install.

## Status & scope

The .NET integration is functional and tested end-to-end (workbench HTML, reverse proxy, WebSocket forwarding, crash recovery). See `TODO.md` for the running task list and `CLAUDE.md` for an architectural deep-dive.

## License

The OpenVSCode Server sources retain their original [MIT license](LICENSE.txt). The .NET integration added under `dotnet/` is also distributed under the MIT license.
