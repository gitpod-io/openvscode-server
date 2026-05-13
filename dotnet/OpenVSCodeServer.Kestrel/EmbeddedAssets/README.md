# Embedded VS Code distributions

Tarballs in this folder are picked up by the `.csproj` via the `EmbeddedResource` glob and shipped inside `OpenVSCodeServer.Kestrel.dll`. The runtime extractor accepts either naming convention:

- `vscode-reh-web-<platform>-<arch>.tar.gz` — what `scripts/build-vscode-release.sh` produces from a local gulp build.
- `openvscode-server-v<X.Y.Z>-<platform>-<arch>.tar.gz` — what `scripts/download-vscode-release.sh` (and the `.ps1` counterpart) drops here from a published gitpod-io release.

The folder is empty in source control on purpose — run one of the two scripts to populate it before building the NuGet package.

For consumers who would rather not embed a 70+ MiB archive into their binary, the library can also fetch the same release tarball at runtime: set `options.Download.Enabled = true` in `AddOpenVSCodeServer`. The archive is cached on disk and reused on subsequent startups.
