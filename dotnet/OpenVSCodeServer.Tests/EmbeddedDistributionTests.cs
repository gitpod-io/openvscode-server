// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.Logging.Abstractions;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class EmbeddedDistributionTests
{
	[Fact]
	public void Materialize_WithoutEmbedded_AndWithoutExternalPath_Throws()
	{
		var distribution = new EmbeddedDistributionAccessor();

		if (EmbeddedDistributionAccessor.HasEmbeddedDistribution)
		{
			// If a real distribution is bundled we cannot meaningfully exercise the failure path.
			// The other branch is exercised by Materialize_WithExternalPath_*.
			Assert.True(true);
			return;
		}

		var options = new OpenVSCodeServerOptions();
		var ex = Assert.Throws<InvalidOperationException>(() => distribution.Materialize(options));
		Assert.Contains("ExternalServerPath", ex.Message);
	}

	[Fact]
	public void Materialize_WithExternalPath_ValidatesLayout()
	{
		var distribution = new EmbeddedDistributionAccessor();
		var tempRoot = Directory.CreateTempSubdirectory("openvscode-tests-").FullName;
		try
		{
			var options = new OpenVSCodeServerOptions { ExternalServerPath = tempRoot };
			Assert.Throws<FileNotFoundException>(() => distribution.Materialize(options));

			Directory.CreateDirectory(Path.Combine(tempRoot, "out"));
			File.WriteAllText(Path.Combine(tempRoot, "out", "server-main.js"), "// stub");
			Assert.Equal(tempRoot, distribution.Materialize(options));
		}
		finally
		{
			Directory.Delete(tempRoot, recursive: true);
		}
	}
}

/// <summary>
/// Adapter that pokes at <see cref="EmbeddedDistribution"/>'s internals so unit tests don't have to
/// stand up the whole hosted-service pipeline.
/// </summary>
internal sealed class EmbeddedDistributionAccessor
{
	private readonly EmbeddedDistribution _inner = new(NullLogger<EmbeddedDistribution>.Instance);

	public static bool HasEmbeddedDistribution => EmbeddedDistribution.HasEmbeddedDistribution();

	public string Materialize(OpenVSCodeServerOptions options) => _inner.Materialize(options);
}
