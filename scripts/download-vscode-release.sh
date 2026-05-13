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
       $0 --all-linux [--version <vX.Y.Z>] [--output-dir <dir>] [--keep-existing]

Options:
  --version       openvscode-server tag (default: pinned in this script)
  --platform      linux | darwin | win32  (default: detected from host)
  --arch          x64 | arm64 | armhf     (default: detected from host)
  --all-linux     Fetch every Linux archive (x64, arm64, armhf) the upstream
                  publishes. Implies --keep-existing for archives that match
                  the pattern. Mutually exclusive with --platform/--arch.
  --sha256        Expected SHA-256 of the archive. When provided the script
                  refuses to install the file unless the hash matches. Only
                  valid when downloading a single archive (no --all-linux).
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
ALL_LINUX=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        --arch) ARCH="$2"; shift 2 ;;
        --sha256) EXPECTED_SHA="$2"; shift 2 ;;
        --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
        --keep-existing) KEEP_EXISTING=1; shift ;;
        --all-linux) ALL_LINUX=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
    esac
done

if [[ "${ALL_LINUX}" -eq 1 ]]; then
    if [[ -n "${PLATFORM}" || -n "${ARCH}" ]]; then
        echo "ERROR: --all-linux is mutually exclusive with --platform and --arch." >&2
        exit 1
    fi
    if [[ -n "${EXPECTED_SHA}" ]]; then
        echo "ERROR: --sha256 cannot be combined with --all-linux (per-arch hashes differ)." >&2
        exit 1
    fi
fi

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

mkdir -p "${OUTPUT_DIR}"

# Compute the list of archives to fetch up-front so a single cleanup pass can preserve all of
# them. For the single-archive path the list has one entry.
TARGETS=()
if [[ "${ALL_LINUX}" -eq 1 ]]; then
    for a in x64 arm64 armhf; do
        TARGETS+=("linux:${a}")
    done
else
    TARGETS+=("${PLATFORM}:${ARCH}")
fi

KEEP_NAMES=()
for t in "${TARGETS[@]}"; do
    KEEP_NAMES+=("openvscode-server-${VERSION_NUM}-${t/:/-}.tar.gz")
done

if [[ "${KEEP_EXISTING}" -eq 0 ]]; then
    # Build a `-not -name X -not -name Y` clause so the cleanup pass keeps every archive we are
    # about to (re)stage.
    PRUNE_ARGS=()
    for n in "${KEEP_NAMES[@]}"; do
        PRUNE_ARGS+=(! -name "${n}")
    done
    find "${OUTPUT_DIR}" -maxdepth 1 -type f \
        \( -name 'vscode-reh-web-*.tar.gz' -o -name 'openvscode-server-*.tar.gz' \) \
        "${PRUNE_ARGS[@]}" -print -delete || true
fi

fetch_one() {
    local platform="$1" arch="$2"
    local archive_name="openvscode-server-${VERSION_NUM}-${platform}-${arch}.tar.gz"
    local archive_url="${BASE_URL}/${TAG}/${archive_name}"

    echo "==> Fetching ${archive_name}"
    echo "    URL:    ${archive_url}"
    echo "    Output: ${OUTPUT_DIR}/${archive_name}"

    local tmp_file
    tmp_file="$(mktemp -t openvscode-download-XXXXXX.tar.gz)"
    # shellcheck disable=SC2064  # we want $tmp_file to be expanded now
    trap "rm -f '${tmp_file}'" RETURN

    if command -v curl >/dev/null 2>&1; then
        curl --fail --location --progress-bar --output "${tmp_file}" "${archive_url}"
    elif command -v wget >/dev/null 2>&1; then
        wget --quiet --show-progress --output-document "${tmp_file}" "${archive_url}"
    else
        echo "ERROR: neither curl nor wget is available." >&2
        return 1
    fi

    local header
    header=$(head -c 2 "${tmp_file}" | od -An -tx1 | tr -d ' \n')
    if [[ "${header}" != "1f8b" ]]; then
        echo "ERROR: downloaded file for ${platform}-${arch} is not a gzip archive (got header '${header}')." >&2
        head -c 256 "${tmp_file}" >&2 || true
        echo >&2
        return 1
    fi

    if [[ -n "${EXPECTED_SHA}" ]]; then
        local actual_sha
        if command -v sha256sum >/dev/null 2>&1; then
            actual_sha=$(sha256sum "${tmp_file}" | awk '{print $1}')
        elif command -v shasum >/dev/null 2>&1; then
            actual_sha=$(shasum -a 256 "${tmp_file}" | awk '{print $1}')
        else
            echo "ERROR: no sha256sum/shasum available to verify --sha256." >&2
            return 1
        fi
        if [[ "${actual_sha}" != "${EXPECTED_SHA}" ]]; then
            echo "ERROR: SHA-256 mismatch." >&2
            echo "  expected: ${EXPECTED_SHA}" >&2
            echo "  actual:   ${actual_sha}" >&2
            return 1
        fi
        echo "    SHA-256 OK (${actual_sha})"
    fi

    mv "${tmp_file}" "${OUTPUT_DIR}/${archive_name}"
    local size
    size=$(du -h "${OUTPUT_DIR}/${archive_name}" | cut -f1)
    echo "    Done. ${archive_name} (${size})."
}

for t in "${TARGETS[@]}"; do
    fetch_one "${t%%:*}" "${t##*:}"
done

echo "==> All requested archives staged in ${OUTPUT_DIR}"
echo "    Run 'dotnet build dotnet/OpenVSCodeServer.slnx' to embed them."
