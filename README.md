# OpenVSCode Server for Kestrel

A .NET port that exposes the [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server) as a first-class component of an ASP.NET Core / Kestrel application.

The original openvscode-server distribution is bundled as embedded resources inside the .NET library. At runtime the assets are extracted to a working directory, the Node-based VS Code server is launched as a managed child process, and Kestrel reverse-proxies HTTP and WebSocket traffic to it through endpoint mappings registered on `IEndpointRouteBuilder`.

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

## Repository layout

```
dotnet/
    OpenVSCodeServer.Kestrel/      class library (embedded VS Code + Kestrel integration)
    OpenVSCodeServer.TestHost/     minimal Kestrel CLI host (manual + Playwright smoke tests)
    OpenVSCodeServer.Tests/        xUnit unit tests
    OpenVSCodeServer.slnx          solution file
scripts/
    build-vscode-release.sh        compiles openvscode-server and packages the embedded asset
src/, extensions/, build/, ...     upstream openvscode-server tree (used only by the build script)
```

The upstream openvscode-server tree is preserved so the bundled distribution can be rebuilt locally with the included script.

## Building

### .NET integration (fast path)

```bash
dotnet build dotnet/OpenVSCodeServer.slnx
```

This builds the library, CLI and tests. If a packaged VS Code distribution is already embedded the library is fully usable. Otherwise the library will report a missing-asset error at startup (see "Build the VS Code distribution" below).

### Build the VS Code distribution (slow path)

```bash
scripts/build-vscode-release.sh                  # current host platform
scripts/build-vscode-release.sh linux x64        # explicit platform/arch
```

The script:

1. Installs npm dependencies for the openvscode-server tree.
2. Runs `npm run gulp vscode-reh-web-<platform>-<arch>-min`.
3. Packages `vscode-reh-web-<platform>-<arch>/` into `dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets/vscode-reh-web-<platform>-<arch>.tar.gz`.

The .csproj picks the file up via a `<Content Include="...">` rule and emits it as an embedded resource. The first time a process initializes, the resource is extracted to `${TEMP}/openvscode-server-<sha>/` (configurable) and reused for subsequent runs.

You can skip the embedded resource entirely and point the library at an existing install via `OpenVSCodeServerOptions.ExternalServerPath`.

## Running the CLI

```bash
dotnet run --project dotnet/OpenVSCodeServer.TestHost
```

The CLI listens on `http://127.0.0.1:5000/ide` by default. Pass `--urls`, `--workspace`, `--external-server-path`, or `--port` to override defaults.

## Testing

```bash
dotnet test dotnet/OpenVSCodeServer.slnx                       # xUnit
dotnet test dotnet/OpenVSCodeServer.slnx --filter Playwright    # browser smoke (requires Playwright browsers)
```

## Status & scope

This is an early-stage port. See `TODO.md` for the running task list and `CLAUDE.md` for an architectural deep-dive.

## License

The OpenVSCode Server sources retain their original [MIT license](LICENSE.txt). The .NET integration added under `dotnet/` is also distributed under the MIT license.
