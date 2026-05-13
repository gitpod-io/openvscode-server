#!/usr/bin/env bash
# Download a pre-built OpenVSCode Server distribution from
# https://github.com/gitpod-io/openvscode-server/releases and stage it under
# dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets/ as a .tar.gz so it gets
# embedded into the library on the next `dotnet build`.
#
# This is the offline alternative to `scripts/build-vscode-release.sh`: instead
# of running the gulp build locally (which needs full npm access, Electron
# headers, a gigabyte of node_modules etc.) it grabs the release artifact
# the upstream project publishes for the requested platform/arch combination.
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [--version <vX.Y.Z>] [--platform <plat>] [--arch <arch>] [--sha256 <hex>]
          [--output-dir <dir>] [--keep-existing]

Options:
  --version       openvscode-server tag (default: pinned in this script)
  --platform      linux | darwin | win32  (default: detected from host)
  --arch          x64 | arm64 | armhf     (default: detected from host)
  --sha256        Expected SHA-256 of the archive. When provided the script
                  refuses to install the file unless the hash matches.
  --output-dir    Target directory for the archive
                  (default: dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets)
  --keep-existing Do not delete other architectures' archives in the output
                  directory. Default behaviour is to clear them so exactly
                  one distribution ends up embedded.
  -h, --help      Show this help.

Environment overrides:
  OPENVSCODE_DOWNLOAD_BASE_URL  Root URL containing the release tag folders.
                                Defaults to the gitpod-io GitHub release URL.

Notes:
  As of openvscode-server v1.109.5 the upstream project only publishes Linux
  artifacts (x64, arm64, armhf). For darwin/win32 builds run
  scripts/build-vscode-release.sh on the target platform.
EOF
}

# Pin the default version. Update this together with the runtime
# OpenVSCodeServerDownloader.DefaultVersion constant in C#.
DEFAULT_VERSION="v1.109.5"

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
        armv7l|armhf) echo armhf ;;
        *) echo x64 ;;
    esac
}

VERSION=""
PLATFORM=""
ARCH=""
EXPECTED_SHA=""
OUTPUT_DIR=""
KEEP_EXISTING=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        --arch) ARCH="$2"; shift 2 ;;
        --sha256) EXPECTED_SHA="$2"; shift 2 ;;
        --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
        --keep-existing) KEEP_EXISTING=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
    esac
done

VERSION="${VERSION:-$DEFAULT_VERSION}"
PLATFORM="${PLATFORM:-$(detect_platform)}"
ARCH="${ARCH:-$(detect_arch)}"

# Normalise version: accept "1.109.5", "v1.109.5", "openvscode-server-v1.109.5".
case "$VERSION" in
    openvscode-server-v*) TAG="$VERSION"; VERSION_NUM="${VERSION#openvscode-server-}" ;;
    v*) TAG="openvscode-server-$VERSION"; VERSION_NUM="$VERSION" ;;
    *)  TAG="openvscode-server-v$VERSION"; VERSION_NUM="v$VERSION" ;;
esac

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets}"

BASE_URL="${OPENVSCODE_DOWNLOAD_BASE_URL:-https://github.com/gitpod-io/openvscode-server/releases/download}"
ARCHIVE_NAME="openvscode-server-${VERSION_NUM}-${PLATFORM}-${ARCH}.tar.gz"
ARCHIVE_URL="${BASE_URL}/${TAG}/${ARCHIVE_NAME}"

echo "==> Fetching ${ARCHIVE_NAME}"
echo "    URL:    ${ARCHIVE_URL}"
echo "    Output: ${OUTPUT_DIR}/${ARCHIVE_NAME}"

mkdir -p "${OUTPUT_DIR}"

if [[ "${KEEP_EXISTING}" -eq 0 ]]; then
    find "${OUTPUT_DIR}" -maxdepth 1 -type f \
        \( -name 'vscode-reh-web-*.tar.gz' -o -name 'openvscode-server-*.tar.gz' \) \
        ! -name "${ARCHIVE_NAME}" -print -delete || true
fi

TMP_FILE="$(mktemp -t openvscode-download-XXXXXX.tar.gz)"
trap 'rm -f "${TMP_FILE}"' EXIT

# Use curl when available, otherwise fall back to wget; both are universal on
# Linux and on macOS, and the script is not used on plain Windows shells.
if command -v curl >/dev/null 2>&1; then
    curl --fail --location --progress-bar --output "${TMP_FILE}" "${ARCHIVE_URL}"
elif command -v wget >/dev/null 2>&1; then
    wget --quiet --show-progress --output-document "${TMP_FILE}" "${ARCHIVE_URL}"
else
    echo "ERROR: neither curl nor wget is available." >&2
    exit 1
fi

# Sanity-check the download. A 404 from GitHub still produces an HTML body, so
# verify the first bytes look like a gzip header (1f 8b).
HEADER=$(head -c 2 "${TMP_FILE}" | od -An -tx1 | tr -d ' \n')
if [[ "${HEADER}" != "1f8b" ]]; then
    echo "ERROR: downloaded file is not a gzip archive (got header '${HEADER}')." >&2
    echo "First bytes of the response:" >&2
    head -c 256 "${TMP_FILE}" >&2 || true
    echo >&2
    exit 1
fi

if [[ -n "${EXPECTED_SHA}" ]]; then
    if command -v sha256sum >/dev/null 2>&1; then
        ACTUAL_SHA=$(sha256sum "${TMP_FILE}" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        ACTUAL_SHA=$(shasum -a 256 "${TMP_FILE}" | awk '{print $1}')
    else
        echo "ERROR: no sha256sum/shasum available to verify --sha256." >&2
        exit 1
    fi
    if [[ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]]; then
        echo "ERROR: SHA-256 mismatch." >&2
        echo "  expected: ${EXPECTED_SHA}" >&2
        echo "  actual:   ${ACTUAL_SHA}" >&2
        exit 1
    fi
    echo "    SHA-256 OK (${ACTUAL_SHA})"
fi

mv "${TMP_FILE}" "${OUTPUT_DIR}/${ARCHIVE_NAME}"
trap - EXIT

SIZE=$(du -h "${OUTPUT_DIR}/${ARCHIVE_NAME}" | cut -f1)
echo "==> Done. ${ARCHIVE_NAME} (${SIZE}) staged in ${OUTPUT_DIR}"
echo "    Run 'dotnet build dotnet/OpenVSCodeServer.slnx' to embed it."
