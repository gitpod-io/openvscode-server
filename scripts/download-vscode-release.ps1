# Download a pre-built OpenVSCode Server distribution from
# https://github.com/gitpod-io/openvscode-server/releases and stage it under
# dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets/ as a .tar.gz for embedding.
#
# PowerShell counterpart of scripts/download-vscode-release.sh — kept in sync.

[CmdletBinding()]
param(
    [string]$Version = 'v1.109.5',
    [ValidateSet('linux', 'darwin', 'win32')]
    [string]$Platform,
    [ValidateSet('x64', 'arm64', 'armhf')]
    [string]$Arch,
    [string]$Sha256,
    [string]$OutputDir,
    [switch]$KeepExisting,
    [switch]$AllLinux
)

$ErrorActionPreference = 'Stop'

if ($AllLinux) {
    if ($Platform -or $Arch) {
        throw '-AllLinux is mutually exclusive with -Platform and -Arch.'
    }
    if ($Sha256) {
        throw '-Sha256 cannot be combined with -AllLinux (per-arch hashes differ).'
    }
}

if (-not $Platform) {
    $Platform = if ($IsLinux)   { 'linux' }
                elseif ($IsMacOS) { 'darwin' }
                else { 'win32' }
}

if (-not $Arch) {
    $Arch = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
        'X64'   { 'x64' }
        'Arm64' { 'arm64' }
        'Arm'   { 'armhf' }
        default { 'x64' }
    }
}

# Accept "1.109.5", "v1.109.5", or "openvscode-server-v1.109.5".
if ($Version -like 'openvscode-server-v*') {
    $tag = $Version
    $versionNum = $Version.Substring('openvscode-server-'.Length)
}
elseif ($Version.StartsWith('v')) {
    $tag = "openvscode-server-$Version"
    $versionNum = $Version
}
else {
    $tag = "openvscode-server-v$Version"
    $versionNum = "v$Version"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir '..')

if (-not $OutputDir) {
    $OutputDir = Join-Path $rootDir 'dotnet/OpenVSCodeServer.Kestrel/EmbeddedAssets'
}

$baseUrl = if ($env:OPENVSCODE_DOWNLOAD_BASE_URL) {
    $env:OPENVSCODE_DOWNLOAD_BASE_URL
} else {
    'https://github.com/gitpod-io/openvscode-server/releases/download'
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

# Compute the list of (platform, arch) pairs to fetch.
$targets = if ($AllLinux) {
    @(
        @{ Platform = 'linux'; Arch = 'x64' },
        @{ Platform = 'linux'; Arch = 'arm64' },
        @{ Platform = 'linux'; Arch = 'armhf' }
    )
} else {
    @(@{ Platform = $Platform; Arch = $Arch })
}

$keepNames = $targets | ForEach-Object { "openvscode-server-$versionNum-$($_.Platform)-$($_.Arch).tar.gz" }

if (-not $KeepExisting) {
    Get-ChildItem -Path $OutputDir -File `
        -Include 'vscode-reh-web-*.tar.gz', 'openvscode-server-*.tar.gz' `
        | Where-Object { $keepNames -notcontains $_.Name } `
        | ForEach-Object {
            Write-Host "    removing $($_.Name)"
            Remove-Item $_.FullName
        }
}

function Invoke-FetchOne {
    param(
        [string]$Platform,
        [string]$Arch
    )

    $archiveName = "openvscode-server-$versionNum-$Platform-$Arch.tar.gz"
    $archiveUrl = "$baseUrl/$tag/$archiveName"

    Write-Host "==> Fetching $archiveName"
    Write-Host "    URL:    $archiveUrl"
    Write-Host "    Output: $OutputDir/$archiveName"

    $tmpFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.IO.Path]::GetRandomFileName() + '.tar.gz')
    try {
        # Invoke-WebRequest streams to disk; -UseBasicParsing avoids the IE engine dep.
        Invoke-WebRequest -Uri $archiveUrl -OutFile $tmpFile -UseBasicParsing

        # Verify gzip magic bytes (1f 8b).
        $bytes = [System.IO.File]::ReadAllBytes($tmpFile) | Select-Object -First 2
        if ($bytes[0] -ne 0x1f -or $bytes[1] -ne 0x8b) {
            throw "Downloaded file for $Platform-$Arch is not a gzip archive (header: $([BitConverter]::ToString($bytes)))."
        }

        if ($Sha256) {
            $actual = (Get-FileHash -Path $tmpFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $Sha256.ToLowerInvariant()) {
                throw "SHA-256 mismatch. expected=$Sha256 actual=$actual"
            }
            Write-Host "    SHA-256 OK ($actual)"
        }

        $target = Join-Path $OutputDir $archiveName
        Move-Item -Force -Path $tmpFile -Destination $target

        $size = (Get-Item $target).Length / 1MB
        Write-Host ("    Done. {0} ({1:N1} MiB)." -f $archiveName, $size)
    }
    finally {
        if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force }
    }
}

foreach ($t in $targets) {
    Invoke-FetchOne -Platform $t.Platform -Arch $t.Arch
}

Write-Host "==> All requested archives staged in $OutputDir"
Write-Host "    Run 'dotnet build dotnet/OpenVSCodeServer.slnx' to embed them."
