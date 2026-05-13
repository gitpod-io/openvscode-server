// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Globalization;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Fetches a pre-built openvscode-server distribution from a release URL and caches the tarball
/// on disk. Acts as a runtime fallback when no archive is embedded into the assembly.
/// </summary>
internal sealed class OpenVSCodeServerDownloader
{
	/// <summary>
	/// Default release tag downloaded when <see cref="OpenVSCodeServerDownloadOptions.Version"/>
	/// is left at its default. Kept in sync with <c>scripts/download-vscode-release.sh</c>.
	/// </summary>
	public const string DefaultVersion = "v1.109.5";

	/// <summary>
	/// Default root URL containing the per-tag release folders.
	/// </summary>
	public const string DefaultBaseUrl = "https://github.com/gitpod-io/openvscode-server/releases/download";

	private readonly ILogger<OpenVSCodeServerDownloader> _logger;
	private readonly Func<HttpClient> _httpClientFactory;

	public OpenVSCodeServerDownloader(ILogger<OpenVSCodeServerDownloader> logger)
		: this(logger, static () => new HttpClient(new HttpClientHandler { AllowAutoRedirect = true }))
	{
	}

	internal OpenVSCodeServerDownloader(
		ILogger<OpenVSCodeServerDownloader> logger,
		Func<HttpClient> httpClientFactory)
	{
		_logger = logger;
		_httpClientFactory = httpClientFactory;
	}

	/// <summary>
	/// Ensures a tarball is present on disk for the configured version and returns its path.
	/// The file is cached, so subsequent calls with the same options are no-ops.
	/// </summary>
	public string EnsureDownloaded(OpenVSCodeServerDownloadOptions options, CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(options);

		var (url, fileName) = ResolveUrl(options);
		var cacheDir = !string.IsNullOrEmpty(options.CacheDirectory)
			? options.CacheDirectory!
			: Path.Combine(Path.GetTempPath(), "openvscode-server-downloads");
		Directory.CreateDirectory(cacheDir);

		var target = Path.Combine(cacheDir, fileName);
		if (File.Exists(target))
		{
			if (TryVerifyCachedFile(target, options, out var cachedHash))
			{
				_logger.LogInformation("Reusing cached openvscode-server archive at {Path} (sha256 {Hash}).", target, cachedHash);
				return target;
			}

			_logger.LogWarning("Cached archive at {Path} failed hash verification; re-downloading.", target);
			File.Delete(target);
		}

		_logger.LogInformation("Downloading openvscode-server from {Url} to {Path}.", url, target);

		var tempFile = target + ".part";
		try
		{
			using var http = _httpClientFactory();
			http.Timeout = options.Timeout;

			using (var response = http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
					.GetAwaiter().GetResult())
			{
				response.EnsureSuccessStatusCode();

				using var src = response.Content.ReadAsStream(cancellationToken);
				using var dst = File.Create(tempFile);
				src.CopyTo(dst);
			}

			VerifyGzipMagic(tempFile);

			var actualSha = ComputeSha256(tempFile);
			if (!string.IsNullOrEmpty(options.Sha256)
				&& !string.Equals(options.Sha256, actualSha, StringComparison.OrdinalIgnoreCase))
			{
				throw new InvalidOperationException(
					$"Downloaded archive failed SHA-256 verification. expected={options.Sha256} actual={actualSha}");
			}

			File.Move(tempFile, target, overwrite: true);
			_logger.LogInformation("Downloaded openvscode-server archive ({Size:N0} bytes, sha256 {Hash}).",
				new FileInfo(target).Length, actualSha);
			return target;
		}
		catch
		{
			TryDelete(tempFile);
			throw;
		}
	}

	/// <summary>
	/// Resolves the archive URL and file name for the given options.
	/// </summary>
	internal static (string Url, string FileName) ResolveUrl(OpenVSCodeServerDownloadOptions options)
	{
		if (!string.IsNullOrEmpty(options.Url))
		{
			var url = options.Url!;
			var fileName = ExtractFileNameFromUrl(url);
			return (url, fileName);
		}

		var (tag, versionNum) = NormalizeVersion(options.Version);
		var platform = GetPlatformToken();
		var arch = GetArchToken();
		var name = $"openvscode-server-{versionNum}-{platform}-{arch}.tar.gz";
		var baseUrl = options.BaseUrl.TrimEnd('/');
		return ($"{baseUrl}/{tag}/{name}", name);
	}

	internal static (string Tag, string VersionNum) NormalizeVersion(string version)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(version);
		if (version.StartsWith("openvscode-server-", StringComparison.Ordinal))
		{
			return (version, version["openvscode-server-".Length..]);
		}
		var versionNum = version.StartsWith('v') ? version : "v" + version;
		return ("openvscode-server-" + versionNum, versionNum);
	}

	private static string ExtractFileNameFromUrl(string url)
	{
		var slash = url.LastIndexOf('/');
		if (slash < 0 || slash == url.Length - 1)
		{
			throw new ArgumentException($"Download URL '{url}' does not contain a file name.", nameof(url));
		}

		var fileName = url[(slash + 1)..];
		var query = fileName.IndexOf('?');
		if (query >= 0)
		{
			fileName = fileName[..query];
		}
		return fileName;
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
		Architecture.Arm => "armhf",
		_ => "x64",
	};

	private static void VerifyGzipMagic(string path)
	{
		using var stream = File.OpenRead(path);
		Span<byte> header = stackalloc byte[2];
		var read = stream.Read(header);
		if (read != 2 || header[0] != 0x1f || header[1] != 0x8b)
		{
			throw new InvalidOperationException(
				$"Downloaded file at '{path}' is not a gzip archive (header was {read} byte(s)).");
		}
	}

	private static bool TryVerifyCachedFile(string path, OpenVSCodeServerDownloadOptions options, out string sha)
	{
		try
		{
			VerifyGzipMagic(path);
			sha = ComputeSha256(path);
			if (!string.IsNullOrEmpty(options.Sha256)
				&& !string.Equals(options.Sha256, sha, StringComparison.OrdinalIgnoreCase))
			{
				return false;
			}
			return true;
		}
		catch
		{
			sha = string.Empty;
			return false;
		}
	}

	private static string ComputeSha256(string path)
	{
		using var stream = File.OpenRead(path);
		using var sha = SHA256.Create();
		var hash = sha.ComputeHash(stream);
		var sb = new StringBuilder(hash.Length * 2);
		foreach (var b in hash)
		{
			sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
		}
		return sb.ToString();
	}

	private static void TryDelete(string path)
	{
		try
		{
			if (File.Exists(path))
			{
				File.Delete(path);
			}
		}
		catch
		{
			// best effort
		}
	}
}
