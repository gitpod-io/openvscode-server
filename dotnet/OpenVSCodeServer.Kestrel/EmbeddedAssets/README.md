# Embedded VS Code distributions

Build artifacts produced by `scripts/build-vscode-release.sh` are dropped here as `vscode-reh-web-<platform>-<arch>.tar.gz`. The .csproj picks them up via the `EmbeddedResource` glob and ships them inside `OpenVSCodeServer.Kestrel.dll`.

The folder is empty in source control on purpose — running the build script populates it.
