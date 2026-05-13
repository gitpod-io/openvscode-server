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
- [x] Verify that an embedded distribution boots end-to-end. The download script was used
      to stage `openvscode-server-v1.109.5-linux-x64.tar.gz` into `EmbeddedAssets/`; the
      .NET integration tests then booted the workbench through Kestrel and asserted the
      HTML response carries VS Code workbench markers.
- [ ] Build a real `vscode-reh-web-linux-x64-min` distribution via `gulp` and verify
      embedding. Re-tested in the sandbox: still blocked because `@vscode/deviceid`
      requires Electron headers from `electronjs.org` and the host returns HTTP 403 for
      that domain (`x-deny-reason: host_not_allowed`). This is an environment-level network
      restriction, not a code issue; the script works on developer machines with full
      network access. The download path (above) covers the operational need.

## Milestone 4 – Verification

- [x] Unit tests for option validation + archive discovery.
- [x] Unit tests for the runtime downloader (URL building, version normalization, gzip
      validation, SHA-256 mismatch, cache reuse).
- [x] Integration test (smoke) that boots the host and hits `/healthz` (skips automatically
      when no distribution is available, runs end-to-end when `OPENVSCODE_EXTERNAL_PATH` is set).
- [x] End-to-end runtime-download smoke test (`OPENVSCODE_ENABLE_DOWNLOAD_TEST=1`) that
      exercises downloader → extraction → child boot → reverse proxy.
- [x] Workbench HTML smoke test now asserts the response contains a VS Code workbench
      marker (`Visual Studio Code` / `workbench` / `vscode-server`) so a wholesale proxy
      regression returns a failing test rather than a silent 200 of the wrong page.
- [ ] True Playwright test that loads the workbench in headless Chromium. Deferred — the
      current HTML-marker check catches every regression we've seen so far without dragging
      a Playwright browser install into the test matrix. Worth adding when JS-bundle issues
      start slipping past the marker check.

## Milestone 5 – Polish / future work

- [x] Connection-token support beyond `WithoutConnectionToken=true`. The proxy now
      injects the configured (or auto-generated) `tkn=` parameter on every upstream
      request so the parent ASP.NET Core app can authenticate the browser without
      exposing the token to it.
- [x] Multi-platform asset selection at runtime. `EmbeddedDistribution.SelectBestCandidate`
      now matches archive file names by hyphen-delimited segments so `arm` and `arm64` are
      distinct, prefers `alpine-*` archives over `linux-*` on musl/Alpine hosts (detected
      via `/etc/alpine-release`, `/lib/ld-musl-*`, or `/etc/os-release`), and falls back to
      an arch-only match before giving up. 32-bit ARM maps to the `armhf` token used by
      gitpod-io's release naming.
- [x] NuGet packaging metadata + README on nuget.org. (`dotnet pack` now produces a
      well-formed .nupkg with README, LICENSE, source link and symbol packages.)
- [x] Sharing one Node process between multiple Kestrel mounts. `MapOpenVSCodeServer` can
      now be called multiple times: the first call establishes the canonical prefix used
      as `--server-base-path`, subsequent calls layer additional routes that funnel into
      the same `OpenVSCodeServerProxy`. The proxy rewrites secondary inbound prefixes to
      the canonical one when forwarding upstream so requests reach the same upstream paths.
      Workbench HTML at a secondary mount still references the canonical prefix in its
      absolute URLs — secondary mounts are best used for API/WebSocket compatibility paths.
- [x] Graceful child-process restart on crash. The hosted service relaunches the
      child on the original port with exponential back-off, capped by
      `MaxRestartAttempts`; reset window prevents transient crashes accumulating
      forever.

## Next steps

Things worth doing next, in rough priority order:

1. **Run the gulp build on a machine with network access** and embed the resulting
   `vscode-reh-web-linux-x64-min` tarball into a release artifact, then verify the embedded
   build path produces the same end-to-end result as the downloaded release (which the
   integration tests already exercise).
2. **Multi-arch / multi-OS release artifacts.** Partial: `download-vscode-release.sh /
   .ps1` now accepts `--all-linux` (`-AllLinux` in PowerShell) and stages all three Linux
   archives gitpod-io publishes (x64, arm64, armhf) in one pass. A "fat" build of the
   library with all three embedded was verified end-to-end (49 tests, including the live
   workbench smoke). Still pending: darwin/win32 staging (requires the gulp build on the
   target platform, or upstream publishing those archives) and a release pipeline that
   emits per-RID NuGet packages rather than one fat package.
3. **Headless Playwright test.** Add a `Microsoft.Playwright` test project gated on an env
   var that loads `/ide/` in a headless Chromium and waits for `monaco-editor` to mount.
   Catches JS-bundle regressions that slip past the HTML-marker check.
4. **Refresh the pinned release.** `OpenVSCodeServerDownloader.DefaultVersion` and
   `scripts/download-vscode-release.sh:DEFAULT_VERSION` are pinned to `v1.109.5`; both
   need to move together when the upstream tag advances.
5. **Tighten secondary-mount semantics.** Today secondary mounts share the upstream
   process but the workbench HTML still references the canonical prefix in its absolute
   links. A real HTML/URL rewriter (e.g. `Microsoft.AspNetCore.Rewrite` middleware) could
   make secondary mounts serve the workbench transparently; deferred until a concrete need
   shows up.
