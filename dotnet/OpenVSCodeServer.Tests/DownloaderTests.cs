// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.IO.Compression;
using System.Net;
using System.Net.Http;
using Microsoft.Extensions.Logging.Abstractions;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class DownloaderTests
{
	[Theory]
	[InlineData("v1.109.5", "openvscode-server-v1.109.5", "v1.109.5")]
	[InlineData("1.109.5", "openvscode-server-v1.109.5", "v1.109.5")]
	[InlineData("openvscode-server-v1.108.2", "openvscode-server-v1.108.2", "v1.108.2")]
	public void NormalizeVersion_AcceptsAllCommonForms(string input, string expectedTag, string expectedVersionNum)
	{
		var (tag, versionNum) = OpenVSCodeServerDownloader.NormalizeVersion(input);
		Assert.Equal(expectedTag, tag);
		Assert.Equal(expectedVersionNum, versionNum);
	}

	[Fact]
	public void ResolveUrl_BuildsExpectedUrlForCurrentRuntime()
	{
		var (url, fileName) = OpenVSCodeServerDownloader.ResolveUrl(new OpenVSCodeServerDownloadOptions
		{
			Version = "v1.109.5",
			BaseUrl = "https://example.test/releases/download",
		});

		// The URL pattern is gitpod-io's; we just verify shape + the file name token matches the platform/arch.
		Assert.StartsWith("https://example.test/releases/download/openvscode-server-v1.109.5/", url);
		Assert.EndsWith(fileName, url);
		Assert.StartsWith("openvscode-server-v1.109.5-", fileName);
		Assert.EndsWith(".tar.gz", fileName);
	}

	[Fact]
	public void ResolveUrl_HonoursExplicitUrlOverride()
	{
		var (url, fileName) = OpenVSCodeServerDownloader.ResolveUrl(new OpenVSCodeServerDownloadOptions
		{
			Url = "https://example.test/some/path/openvscode-server-custom.tar.gz?token=abc",
		});

		Assert.Equal("https://example.test/some/path/openvscode-server-custom.tar.gz?token=abc", url);
		Assert.Equal("openvscode-server-custom.tar.gz", fileName);
	}

	[Fact]
	public void EnsureDownloaded_StreamsResponseAndCachesByFileName()
	{
		var archive = BuildFakeGzipArchive();
		var calls = 0;
		var downloader = new OpenVSCodeServerDownloader(
			NullLogger<OpenVSCodeServerDownloader>.Instance,
			() => new HttpClient(new StaticHandler(_ =>
			{
				calls++;
				return new HttpResponseMessage(HttpStatusCode.OK)
				{
					Content = new ByteArrayContent(archive),
				};
			})));

		var cacheDir = Directory.CreateTempSubdirectory("openvscode-download-tests-").FullName;
		try
		{
			var options = new OpenVSCodeServerDownloadOptions
			{
				Url = "https://example.test/some/openvscode-server-test.tar.gz",
				CacheDirectory = cacheDir,
			};

			var first = downloader.EnsureDownloaded(options);
			var second = downloader.EnsureDownloaded(options);

			Assert.Equal(first, second);
			Assert.Equal(Path.Combine(cacheDir, "openvscode-server-test.tar.gz"), first);
			Assert.True(File.Exists(first));
			Assert.Equal(archive, File.ReadAllBytes(first));
			Assert.Equal(1, calls);
		}
		finally
		{
			Directory.Delete(cacheDir, recursive: true);
		}
	}

	[Fact]
	public void EnsureDownloaded_FailsWhenResponseIsNotGzip()
	{
		var notGzip = new byte[] { 0x00, 0x01, 0x02 };
		var downloader = new OpenVSCodeServerDownloader(
			NullLogger<OpenVSCodeServerDownloader>.Instance,
			() => new HttpClient(new StaticHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
			{
				Content = new ByteArrayContent(notGzip),
			})));

		var cacheDir = Directory.CreateTempSubdirectory("openvscode-download-tests-").FullName;
		try
		{
			var ex = Assert.Throws<InvalidOperationException>(() => downloader.EnsureDownloaded(new OpenVSCodeServerDownloadOptions
			{
				Url = "https://example.test/bad.tar.gz",
				CacheDirectory = cacheDir,
			}));

			Assert.Contains("not a gzip archive", ex.Message);
			Assert.Empty(Directory.GetFiles(cacheDir, "*.tar.gz"));
		}
		finally
		{
			Directory.Delete(cacheDir, recursive: true);
		}
	}

	[Fact]
	public void EnsureDownloaded_FailsOnSha256Mismatch()
	{
		var archive = BuildFakeGzipArchive();
		var downloader = new OpenVSCodeServerDownloader(
			NullLogger<OpenVSCodeServerDownloader>.Instance,
			() => new HttpClient(new StaticHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
			{
				Content = new ByteArrayContent(archive),
			})));

		var cacheDir = Directory.CreateTempSubdirectory("openvscode-download-tests-").FullName;
		try
		{
			var ex = Assert.Throws<InvalidOperationException>(() => downloader.EnsureDownloaded(new OpenVSCodeServerDownloadOptions
			{
				Url = "https://example.test/mismatch.tar.gz",
				CacheDirectory = cacheDir,
				Sha256 = "0000000000000000000000000000000000000000000000000000000000000000",
			}));

			Assert.Contains("SHA-256", ex.Message);
		}
		finally
		{
			Directory.Delete(cacheDir, recursive: true);
		}
	}

	private static byte[] BuildFakeGzipArchive()
	{
		using var ms = new MemoryStream();
		using (var gzip = new GZipStream(ms, CompressionMode.Compress, leaveOpen: true))
		{
			gzip.Write("not a real tarball, just a valid gzip stream"u8);
		}
		return ms.ToArray();
	}

	private sealed class StaticHandler : HttpMessageHandler
	{
		private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;

		public StaticHandler(Func<HttpRequestMessage, HttpResponseMessage> respond)
		{
			_respond = respond;
		}

		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
			=> Task.FromResult(_respond(request));
	}
}
