#!/usr/bin/env bash
# Build the openvscode-server distribution and stage it as an embedded resource for the
# .NET library. This is intentionally idempotent so it can be re-run after a code change.
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [platform] [arch]
  platform   linux | darwin | win32 | alpine   (default: detected from host)
  arch       x64 | arm64 | ia32                 (default: detected from host)

Output:
  dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets/vscode-reh-web-<platform>-<arch>.tar.gz
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

# Resolve the repository root from the location of this script so the build doesn't depend on
# the caller's working directory.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# --- platform / arch detection ---
detect_platform() {
    case "$(uname -s)" in
        Linux*)  echo linux ;;
        Darwin*) echo darwin ;;
        MINGW*|MSYS*|CYGWIN*) echo win32 ;;
        *) echo linux ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo x64 ;;
        aarch64|arm64) echo arm64 ;;
        i?86) echo ia32 ;;
        *) echo x64 ;;
    esac
}

PLATFORM="${1:-$(detect_platform)}"
ARCH="${2:-$(detect_arch)}"
DISTRO_NAME="vscode-reh-web-${PLATFORM}-${ARCH}"

echo "==> Building ${DISTRO_NAME}"
echo "    repo: ${ROOT_DIR}"

cd "$ROOT_DIR"

# --- npm install -----------------------------------------------------------------------------
if [[ ! -d node_modules || "${SKIP_NPM_INSTALL:-0}" != "1" ]]; then
    echo "==> npm install (set SKIP_NPM_INSTALL=1 to skip)"
    npm install
else
    echo "==> Skipping npm install (SKIP_NPM_INSTALL=1)"
fi

# --- gulp build -----------------------------------------------------------------------------
GULP_TASK="${DISTRO_NAME}-min"
echo "==> npm run gulp ${GULP_TASK}"
npm run gulp -- "${GULP_TASK}"

# The gulp output lives one level above the repo (BUILD_ROOT = path.dirname(REPO_ROOT)).
BUILD_ROOT=$(cd "$ROOT_DIR/.." && pwd)
BUILD_OUTPUT="${BUILD_ROOT}/${DISTRO_NAME}"
if [[ ! -d "${BUILD_OUTPUT}" ]]; then
    echo "ERROR: expected gulp output directory not found: ${BUILD_OUTPUT}" >&2
    exit 1
fi

# --- package as tar.gz ----------------------------------------------------------------------
EMBED_DIR="${ROOT_DIR}/dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets"
mkdir -p "${EMBED_DIR}"

# Remove other architectures' archives so we always embed exactly one matching distribution.
find "${EMBED_DIR}" -maxdepth 1 -name 'vscode-reh-web-*.tar.gz' -print -delete || true

ARCHIVE="${EMBED_DIR}/${DISTRO_NAME}.tar.gz"
echo "==> Packaging ${BUILD_OUTPUT} -> ${ARCHIVE}"
tar -C "${BUILD_ROOT}" -czf "${ARCHIVE}" "${DISTRO_NAME}"

echo "==> Done. Archive size: $(du -h "${ARCHIVE}" | cut -f1)"
echo "    Run 'dotnet build dotnet/OpenVSCodeServer.sln' to embed it."
