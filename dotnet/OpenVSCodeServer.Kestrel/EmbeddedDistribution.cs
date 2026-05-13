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

	public EmbeddedDistribution(ILogger<EmbeddedDistribution> logger)
	{
		_logger = logger;
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

		var (resourceName, _) = FindEmbeddedResource()
			?? throw new InvalidOperationException(
				"No embedded openvscode-server archive was found and OpenVSCodeServerOptions.ExternalServerPath was not set. "
				+ "Run scripts/build-vscode-release.sh to produce one, or point ExternalServerPath at an existing install.");

		var asm = typeof(EmbeddedDistribution).Assembly;
		using var stream = asm.GetManifestResourceStream(resourceName)
			?? throw new InvalidOperationException($"Embedded resource '{resourceName}' could not be opened.");

		var hash = ComputeSha256(stream);
		stream.Position = 0;

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

		_logger.LogInformation("Extracting embedded openvscode-server ({Resource}) to {Path}", resourceName, installRoot);
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

		var platformToken = GetPlatformToken();
		var archToken = GetArchToken();

		var preferred = candidates.FirstOrDefault(c =>
			c.FileName.Contains(platformToken, StringComparison.Ordinal) &&
			c.FileName.Contains(archToken, StringComparison.Ordinal));
		if (preferred.Name is not null)
		{
			return preferred;
		}

		// Fall back to the first archive we find — better than failing outright on exotic RIDs.
		return candidates[0];
	}

	private static string GetPlatformToken()
	{
		if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
		{
			return "linux";
		}
		if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
		{
			return "darwin";
		}
		if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
		{
			return "win32";
		}
		return "linux";
	}

	private static string GetArchToken() => RuntimeInformation.OSArchitecture switch
	{
		Architecture.X64 => "x64",
		Architecture.Arm64 => "arm64",
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
