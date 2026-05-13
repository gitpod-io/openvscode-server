# Repository overview — OpenVSCode Server / Kestrel port

This repository is the upstream [`gitpod-io/openvscode-server`](https://github.com/gitpod-io/openvscode-server) tree (a fork of `microsoft/vscode` with a server-mode glue layer) plus an additional `dotnet/` tree that integrates the compiled server into ASP.NET Core / Kestrel applications.

The .NET-specific project guidance is in this file. The original Microsoft / VS Code contributor guidance for the JS/TS code lives in `.claude/CLAUDE.md`.

## What we are building

A NuGet-shaped library (`OpenVSCodeServer.Kestrel`) that lets any Kestrel host add a fully-functional VS Code web IDE to an existing ASP.NET Core pipeline with three lines of code:

```csharp
builder.Services.AddOpenVSCodeServer(options => { /* … */ });
app.MapOpenVSCodeServer("/ide");
```

## Architectural approach

A pure-managed re-implementation of the OpenVSCode server is not feasible — the extension host runs Node.js, language servers spawn child processes, terminals require a real PTY, and the upstream code is hundreds of thousands of lines of TypeScript. The pragmatic path is to embed the upstream Node-based distribution and treat Kestrel as a reverse proxy in front of it.

```
┌───────────────────────────┐    127.0.0.1:<auto>      ┌──────────────────────┐
│ Kestrel listener (yours)  │ ───────────────────────▶ │  node server-main.js │
│ /ide  + WebSockets        │ ◀─────────────────────── │  (openvscode-server) │
└───────────────────────────┘                           └──────────────────────┘
```

Concretely:

1. **Embedded asset**: the compiled `vscode-reh-web-<plat>-<arch>` folder is packed into a `.tar.gz` and embedded as a managed resource in `OpenVSCodeServer.Kestrel.dll`. A SHA-256 hash of the archive determines the extraction directory so multiple library versions can coexist.
2. **Asset extraction**: on first use, the archive is unpacked under `${TEMP}/openvscode-server-<sha>/` (configurable). The bundled `node` binary is marked executable.
3. **Process supervision**: an `IHostedService` boots the Node process with `--host 127.0.0.1 --port <ephemeral> --without-connection-token` (defaults), reads stdout until it sees the `Web UI available at …` line, then signals readiness. The service kills the child on host shutdown.
4. **Reverse proxy**: a Kestrel endpoint (`MapOpenVSCodeServer`) forwards both ordinary HTTP and WebSocket upgrades to the child server. The implementation is in-tree (no Yarp dependency) to keep the library light.
5. **Path prefix**: when mounted at `/ide`, the library rewrites the inbound request path so the upstream server (which assumes it owns `/`) is unaware. The upstream `--server-base-path` option is set so generated absolute URLs remain correct.

## Project layout under `dotnet/`

| Project                       | Purpose                                                        |
|-------------------------------|----------------------------------------------------------------|
| `OpenVSCodeServer.Kestrel`    | Class library. Public surface = options + extension methods.   |
| `OpenVSCodeServer.TestHost`   | Minimal CLI host used for manual testing and Playwright smoke. |
| `OpenVSCodeServer.Tests`      | xUnit unit + integration tests.                                |

## Public surface (v0)

```csharp
namespace OpenVSCodeServer.Kestrel;

public sealed class OpenVSCodeServerOptions
{
    public string? WorkspaceFolder { get; set; }
    public string? ExtractionDirectory { get; set; }
    public string? ExternalServerPath { get; set; }
    public string? ConnectionToken { get; set; }
    public bool WithoutConnectionToken { get; set; } = true;
    public string Host { get; set; } = "127.0.0.1";
    public int? Port { get; set; }                 // null = ephemeral
    public TimeSpan StartupTimeout { get; set; }   = TimeSpan.FromSeconds(60);
    public IList<string> AdditionalArguments { get; } = new List<string>();
}

public static class OpenVSCodeServerServiceCollectionExtensions
{
    public static IServiceCollection AddOpenVSCodeServer(this IServiceCollection services);
    public static IServiceCollection AddOpenVSCodeServer(this IServiceCollection services, Action<OpenVSCodeServerOptions> configure);
}

public static class OpenVSCodeServerEndpointRouteBuilderExtensions
{
    public static IEndpointConventionBuilder MapOpenVSCodeServer(this IEndpointRouteBuilder endpoints, string pathPrefix = "/");
}
```

## How the upstream tree is built

`scripts/build-vscode-release.sh` is a thin wrapper around the existing gulp tasks (`vscode-reh-web-<platform>-<arch>-min`). After the gulp build it tars the output and copies it into `dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets/`. The .csproj contains `<EmbeddedResource Include="EmbeddedAssets\*.tar.gz" />` so the archive ends up inside the produced DLL.

The library probes embedded resources at runtime, picking the archive whose name encodes the running platform/architecture. If none matches and no `ExternalServerPath` is provided, startup fails with a clear error.

## Coding conventions

- Target framework: `net10.0` (the .NET runtime available on this machine).
- `Nullable` is enabled; `ImplicitUsings` is enabled.
- Public API has XML doc comments; internal types are kept `internal`.
- No `async void` outside event handlers, no `.Result`/`.Wait()` in the hot path.
- Tests use xUnit + FluentAssertions style assertions and live in `OpenVSCodeServer.Tests`.

## What this port does NOT do

- It does not re-implement the VS Code server in C#.
- It does not replace Node.js — a Node runtime ships inside the embedded archive.
- It does not modify the upstream `src/`, `extensions/`, or `build/` trees; the .NET integration sits entirely under `dotnet/`.
