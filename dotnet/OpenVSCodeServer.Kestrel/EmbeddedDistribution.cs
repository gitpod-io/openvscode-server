// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Globalization;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Locates the embedded openvscode-server tarball matching the current runtime and extracts it
/// to a deterministic directory derived from a hash of the archive bytes.
/// </summary>
internal sealed class EmbeddedDistribution
{
	private const string ResourceNamespace = "OpenVSCodeServer.Kestrel.EmbeddedAssets.";

	private readonly ILogger<EmbeddedDistribution> _logger;
	private readonly OpenVSCodeServerDownloader? _downloader;

	public EmbeddedDistribution(ILogger<EmbeddedDistribution> logger)
		: this(logger, downloader: null)
	{
	}

	public EmbeddedDistribution(
		ILogger<EmbeddedDistribution> logger,
		OpenVSCodeServerDownloader? downloader)
	{
		_logger = logger;
		_downloader = downloader;
	}

	/// <summary>
	/// Returns the local filesystem path of an openvscode-server install ready for use.
	/// </summary>
	/// <param name="options">Configured options. <see cref="OpenVSCodeServerOptions.ExternalServerPath"/>
	/// short-circuits the embedded extraction path.</param>
	public string Materialize(OpenVSCodeServerOptions options)
	{
		if (!string.IsNullOrEmpty(options.ExternalServerPath))
		{
			ValidateInstall(options.ExternalServerPath!);
			return options.ExternalServerPath!;
		}

		var embedded = FindEmbeddedResource();
		if (embedded is not null)
		{
			return MaterializeFromEmbedded(embedded.Value.ResourceName, options);
		}

		if (options.Download.Enabled)
		{
			return MaterializeFromDownload(options);
		}

		throw new InvalidOperationException(
			"No embedded openvscode-server archive was found and OpenVSCodeServerOptions.ExternalServerPath was not set. "
			+ "Either run scripts/build-vscode-release.sh / scripts/download-vscode-release.sh to embed an archive, "
			+ "set ExternalServerPath, or enable OpenVSCodeServerOptions.Download.Enabled to fetch one at runtime.");
	}

	private string MaterializeFromEmbedded(string resourceName, OpenVSCodeServerOptions options)
	{
		var asm = typeof(EmbeddedDistribution).Assembly;
		using var stream = asm.GetManifestResourceStream(resourceName)
			?? throw new InvalidOperationException($"Embedded resource '{resourceName}' could not be opened.");

		var hash = ComputeSha256(stream);
		stream.Position = 0;

		return MaterializeFromStream(stream, hash, resourceName, options);
	}

	private string MaterializeFromDownload(OpenVSCodeServerOptions options)
	{
		if (_downloader is null)
		{
			throw new InvalidOperationException(
				"Download is enabled but no OpenVSCodeServerDownloader is registered. "
				+ "Ensure AddOpenVSCodeServer registers the downloader (it does by default).");
		}

		var path = _downloader.EnsureDownloaded(options.Download);
		using var stream = File.OpenRead(path);
		var hash = ComputeSha256(stream);
		stream.Position = 0;
		return MaterializeFromStream(stream, hash, $"downloaded:{Path.GetFileName(path)}", options);
	}

	private string MaterializeFromStream(Stream stream, string hash, string sourceLabel, OpenVSCodeServerOptions options)
	{
		var extractionRoot = !string.IsNullOrEmpty(options.ExtractionDirectory)
			? options.ExtractionDirectory!
			: Path.Combine(Path.GetTempPath(), "openvscode-server-" + hash[..16]);
		Directory.CreateDirectory(extractionRoot);

		var stampFile = Path.Combine(extractionRoot, ".materialized");
		var installRoot = Path.Combine(extractionRoot, "install");

		if (File.Exists(stampFile) && File.ReadAllText(stampFile).Trim() == hash && Directory.Exists(installRoot))
		{
			_logger.LogInformation("Reusing extracted openvscode-server at {Path}", installRoot);
			ValidateInstall(installRoot);
			return installRoot;
		}

		if (Directory.Exists(installRoot))
		{
			Directory.Delete(installRoot, recursive: true);
		}
		Directory.CreateDirectory(installRoot);

		_logger.LogInformation("Extracting openvscode-server ({Source}) to {Path}", sourceLabel, installRoot);
		ExtractTarGz(stream, installRoot);
		MakeRootBinariesExecutable(installRoot);

		File.WriteAllText(stampFile, hash);
		ValidateInstall(installRoot);
		return installRoot;
	}

	/// <summary>
	/// Returns true when at least one embedded openvscode-server tarball can be loaded from this assembly.
	/// </summary>
	public static bool HasEmbeddedDistribution() => FindEmbeddedResource() is not null;

	private static (string ResourceName, string FileName)? FindEmbeddedResource()
	{
		var asm = typeof(EmbeddedDistribution).Assembly;
		var candidates = asm.GetManifestResourceNames()
			.Where(name => name.StartsWith(ResourceNamespace, StringComparison.Ordinal)
				&& name.EndsWith(".tar.gz", StringComparison.Ordinal))
			.Select(name => (Name: name, FileName: name[ResourceNamespace.Length..]))
			.ToArray();

		if (candidates.Length == 0)
		{
			return null;
		}

		return SelectBestCandidate(candidates, GetRuntimePlatformTokens(), GetArchToken());
	}

	/// <summary>
	/// Picks the archive that best matches the current platform/architecture from a set of
	/// candidates. The platform tokens are tried in order (e.g. ["alpine", "linux"] for a musl
	/// host) and the first arch-matching candidate wins. Falls back to the first arch-matching
	/// candidate when no platform token matches, and finally to the first candidate of any kind.
	/// </summary>
	internal static (string ResourceName, string FileName)? SelectBestCandidate(
		IReadOnlyList<(string Name, string FileName)> candidates,
		IReadOnlyList<string> platformTokensInPreferenceOrder,
		string archToken)
	{
		// Arch is matched by surrounding hyphens so "arm" doesn't match "arm64" and vice versa.
		bool ArchMatches(string fileName) => HasToken(fileName, archToken);

		foreach (var plat in platformTokensInPreferenceOrder)
		{
			foreach (var c in candidates)
			{
				if (HasToken(c.FileName, plat) && ArchMatches(c.FileName))
				{
					return c;
				}
			}
		}

		// Lenient fallback: arch match only. Useful when a single linux-x64 tarball is embedded on
		// a glibc host that happens to report differently (e.g. nested containers).
		foreach (var c in candidates)
		{
			if (ArchMatches(c.FileName))
			{
				return c;
			}
		}

		// Last resort: don't fail outright — return whatever is embedded and let runtime fail loud
		// if it's incompatible.
		return candidates[0];
	}

	/// <summary>
	/// Returns whether <paramref name="fileName"/> contains <paramref name="token"/> as a
	/// distinct hyphen-delimited segment (so "arm" doesn't match "arm64").
	/// </summary>
	internal static bool HasToken(string fileName, string token)
	{
		if (string.IsNullOrEmpty(token))
		{
			return false;
		}

		var span = fileName.AsSpan();
		var start = 0;
		while (start < span.Length)
		{
			var idx = span[start..].IndexOf(token, StringComparison.Ordinal);
			if (idx < 0)
			{
				return false;
			}
			var abs = start + idx;
			var before = abs == 0 || span[abs - 1] is '-' or '.';
			var afterIdx = abs + token.Length;
			var after = afterIdx >= span.Length || span[afterIdx] is '-' or '.';
			if (before && after)
			{
				return true;
			}
			start = abs + 1;
		}
		return false;
	}

	/// <summary>
	/// Returns the platform tokens recognised in archive file names, in preference order.
	/// Musl-libc hosts (Alpine etc.) get "alpine" before "linux"; macOS gets "darwin"; Windows
	/// gets "win32". The fallback chain lets a single linux glibc tarball still be picked up on
	/// an Alpine host with a clear runtime failure later if it really is incompatible.
	/// </summary>
	internal static IReadOnlyList<string> GetRuntimePlatformTokens()
	{
		if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
		{
			return ["darwin"];
		}
		if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
		{
			return ["win32"];
		}
		if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
		{
			return IsMuslLibc() ? ["alpine", "linux"] : ["linux"];
		}
		return ["linux"];
	}

	private static bool IsMuslLibc()
	{
		// Cheapest reliable signals: a musl ld.so on the system, /etc/alpine-release on Alpine,
		// or "alpine"/"musl" markers in /etc/os-release. Any one is enough.
		try
		{
			if (File.Exists("/etc/alpine-release"))
			{
				return true;
			}

			const string libDir = "/lib";
			if (Directory.Exists(libDir))
			{
				foreach (var entry in Directory.EnumerateFiles(libDir, "ld-musl-*"))
				{
					_ = entry; // suppress unused
					return true;
				}
			}

			if (File.Exists("/etc/os-release"))
			{
				foreach (var line in File.ReadLines("/etc/os-release"))
				{
					if (line.Contains("alpine", StringComparison.OrdinalIgnoreCase)
						|| line.Contains("musl", StringComparison.OrdinalIgnoreCase))
					{
						return true;
					}
				}
			}
		}
		catch
		{
			// Best effort; if probing fails we assume glibc.
		}
		return false;
	}

	private static string GetArchToken() => RuntimeInformation.OSArchitecture switch
	{
		Architecture.X64 => "x64",
		Architecture.Arm64 => "arm64",
		// Gitpod-io publishes 32-bit ARM archives as "armhf"; the local gulp build also names
		// them that way. Map Architecture.Arm (32-bit) to the same token.
		Architecture.Arm => "armhf",
		Architecture.X86 => "ia32",
		_ => "x64",
	};

	private static string ComputeSha256(Stream stream)
	{
		using var sha = SHA256.Create();
		var hash = sha.ComputeHash(stream);
		var sb = new StringBuilder(hash.Length * 2);
		foreach (var b in hash)
		{
			sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
		}
		return sb.ToString();
	}

	private static void ExtractTarGz(Stream archive, string destinationDirectory)
	{
		using var gzip = new GZipStream(archive, CompressionMode.Decompress, leaveOpen: true);
		using var tar = new System.Formats.Tar.TarReader(gzip);
		while (tar.GetNextEntry() is { } entry)
		{
			var relative = entry.Name.Replace('\\', '/').TrimStart('/');

			// Strip a single leading "vscode-reh-web-<plat>-<arch>/" folder so the entry layout
			// becomes the install root directly (bin/, out/, node, ...).
			var firstSlash = relative.IndexOf('/');
			if (firstSlash > 0)
			{
				relative = relative[(firstSlash + 1)..];
			}
			else if (firstSlash == -1)
			{
				continue; // top-level directory entry, skip
			}

			if (string.IsNullOrEmpty(relative))
			{
				continue;
			}

			var target = Path.Combine(destinationDirectory, relative);
			switch (entry.EntryType)
			{
				case System.Formats.Tar.TarEntryType.Directory:
					Directory.CreateDirectory(target);
					break;
				case System.Formats.Tar.TarEntryType.RegularFile:
				case System.Formats.Tar.TarEntryType.V7RegularFile:
					Directory.CreateDirectory(Path.GetDirectoryName(target)!);
					entry.ExtractToFile(target, overwrite: true);
					if (!OperatingSystem.IsWindows() && (entry.Mode & UnixFileMode.UserExecute) != 0)
					{
						File.SetUnixFileMode(target, entry.Mode);
					}
					break;
				case System.Formats.Tar.TarEntryType.SymbolicLink:
					Directory.CreateDirectory(Path.GetDirectoryName(target)!);
					if (File.Exists(target))
					{
						File.Delete(target);
					}
					File.CreateSymbolicLink(target, entry.LinkName);
					break;
				default:
					// Hard links, character/block devices etc. are not expected in a server archive.
					break;
			}
		}
	}

	private static void MakeRootBinariesExecutable(string installRoot)
	{
		if (OperatingSystem.IsWindows())
		{
			return;
		}

		var candidates = new[]
		{
			Path.Combine(installRoot, "node"),
			Path.Combine(installRoot, "bin", "openvscode-server"),
			Path.Combine(installRoot, "bin", "remote-cli", "openvscode-server"),
		};

		foreach (var candidate in candidates)
		{
			if (File.Exists(candidate))
			{
				var mode = File.GetUnixFileMode(candidate);
				File.SetUnixFileMode(candidate, mode
					| UnixFileMode.UserExecute
					| UnixFileMode.GroupExecute
					| UnixFileMode.OtherExecute);
			}
		}
	}

	private static void ValidateInstall(string installRoot)
	{
		if (!Directory.Exists(installRoot))
		{
			throw new DirectoryNotFoundException($"openvscode-server install directory not found: {installRoot}");
		}

		var serverMain = Path.Combine(installRoot, "out", "server-main.js");
		if (!File.Exists(serverMain))
		{
			throw new FileNotFoundException(
				$"openvscode-server install at '{installRoot}' is missing 'out/server-main.js'.",
				serverMain);
		}
	}
}
