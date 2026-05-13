// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class OptionDefaultsTests
{
	[Fact]
	public void Defaults_AreSensible()
	{
		var options = new OpenVSCodeServerOptions();

		Assert.True(options.WithoutConnectionToken);
		Assert.Equal("127.0.0.1", options.Host);
		Assert.Null(options.Port);
		Assert.Equal(TimeSpan.FromSeconds(60), options.StartupTimeout);
		Assert.Equal("/", options.PathPrefix);
		Assert.Empty(options.AdditionalArguments);
		Assert.Empty(options.EnvironmentOverrides);
	}

	[Fact]
	public void AddOpenVSCodeServer_RegistersExpectedServices()
	{
		var services = new ServiceCollection();
		services.AddLogging();
		services.AddOpenVSCodeServer(opts =>
		{
			opts.WorkspaceFolder = "/tmp";
			opts.Port = 12345;
		});

		var provider = services.BuildServiceProvider();
		var resolved = provider.GetRequiredService<IOptions<OpenVSCodeServerOptions>>().Value;

		Assert.Equal("/tmp", resolved.WorkspaceFolder);
		Assert.Equal(12345, resolved.Port);
	}
}
