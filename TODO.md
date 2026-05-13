# TODO — Kestrel port

Tracker for the OpenVSCode Server → Kestrel port. Tick items as they complete.

## Milestone 0 – Bootstrap

- [x] Add `CLAUDE.md` / rewrite `README.md` / add this `TODO.md`.
- [x] Create `dotnet/` solution with three projects (library, CLI test host, xUnit tests).
- [x] Define public option type + extension-method skeleton.

## Milestone 1 – Process plumbing

- [x] Implement embedded-resource discovery (`EmbeddedAssets/vscode-reh-web-<plat>-<arch>.tar.gz`).
- [x] Implement archive extraction with content-hash cache directory.
- [x] Implement Node process launcher (ephemeral port selection, argument builder, stdout-watcher for "Web UI available" handshake).
- [x] Wire the launcher up as an `IHostedService`.

## Milestone 2 – Kestrel integration

- [x] Implement an HTTP reverse-proxy middleware using `HttpClient` + `HttpClientHandler` (no Yarp dependency).
- [x] Add WebSocket forwarding (`HttpContext.WebSockets.AcceptWebSocketAsync` + `ClientWebSocket`).
- [x] Implement path-prefix mount with `--server-base-path` forwarded to the child server.
- [x] Expose endpoint convention via `MapOpenVSCodeServer`.

## Milestone 3 – Build pipeline

- [x] Add `scripts/build-vscode-release.sh` that runs the gulp build and copies the tarball to `EmbeddedAssets/`.
- [x] Add `scripts/download-vscode-release.sh` (+ `.ps1`) that fetches a pre-built
      gitpod-io/openvscode-server release into `EmbeddedAssets/` for embedding. Provides
      an offline-friendly alternative to the gulp build when only embedding is needed.
- [x] Add `OpenVSCodeServerDownloader` for runtime fallback: when no archive is embedded
      and `OpenVSCodeServerOptions.Download.Enabled` is true, the library fetches and
      caches a release tarball at startup. Hash-verified, opt-in only.
- [ ] Build a real `vscode-reh-web-linux-x64-min` distribution and verify embedding.
      The build was attempted inside the development sandbox and failed at `npm install`
      because `@vscode/deviceid` requires Electron headers and `electronjs.org` is not
      reachable from this environment (HTTP 403). The script works on a developer machine
      with full network access; it is intentionally left for the operator to run. The
      download script verified end-to-end against the v1.109.5 release in the sandbox.

## Milestone 4 – Verification

- [x] Unit tests for option validation + archive discovery.
- [x] Unit tests for the runtime downloader (URL building, version normalization, gzip
      validation, SHA-256 mismatch, cache reuse).
- [x] Integration test (smoke) that boots the host and hits `/healthz` (skips automatically
      when no distribution is available, runs end-to-end when `OPENVSCODE_EXTERNAL_PATH` is set).
- [x] End-to-end runtime-download smoke test (`OPENVSCODE_ENABLE_DOWNLOAD_TEST=1`) that
      exercises downloader → extraction → child boot → reverse proxy.
- [ ] Playwright test that loads the workbench in Chromium. Stubbed out — see Milestone 3 for
      why the embedded distribution is unavailable in CI. Once a built install exists, point
      `OPENVSCODE_EXTERNAL_PATH` at it and add a Playwright test that loads `/ide/`.

## Milestone 5 – Polish / future work

- [ ] Connection-token support beyond `WithoutConnectionToken=true`.
- [ ] Multi-platform asset selection at runtime (we already pick a single embedded archive — extend to musl/alpine and arm64 when the build script grows).
- [ ] NuGet packaging metadata + README on nuget.org.
- [ ] Optional support for sharing one Node process between multiple Kestrel mounts.
- [ ] Graceful child-process restart on crash.
