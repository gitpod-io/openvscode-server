// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Reflection;
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

	[Fact]
	public void Validate_AcceptsDefaultOptions()
	{
		InvokeValidate(new OpenVSCodeServerOptions());
	}

	[Theory]
	[InlineData(-1)]
	[InlineData(70000)]
	public void Validate_RejectsOutOfRangePort(int port)
	{
		var ex = Assert.Throws<ArgumentOutOfRangeException>(() =>
			InvokeValidate(new OpenVSCodeServerOptions { Port = port }));
		Assert.Equal("Port", ex.ParamName);
	}

	[Fact]
	public void Validate_RejectsNonPositiveStartupTimeout()
	{
		Assert.Throws<ArgumentOutOfRangeException>(() =>
			InvokeValidate(new OpenVSCodeServerOptions { StartupTimeout = TimeSpan.Zero }));
	}

	[Fact]
	public void Validate_RejectsNegativeMaxRestartAttempts()
	{
		Assert.Throws<ArgumentOutOfRangeException>(() =>
			InvokeValidate(new OpenVSCodeServerOptions { MaxRestartAttempts = -1 }));
	}

	[Fact]
	public void Validate_RejectsMaxDelayBelowInitial()
	{
		Assert.Throws<ArgumentException>(() =>
			InvokeValidate(new OpenVSCodeServerOptions
			{
				RestartInitialDelay = TimeSpan.FromSeconds(5),
				RestartMaxDelay = TimeSpan.FromSeconds(1),
			}));
	}

	[Fact]
	public void Validate_RejectsEmptyConnectionTokenWhenAuthRequired()
	{
		Assert.Throws<ArgumentException>(() =>
			InvokeValidate(new OpenVSCodeServerOptions
			{
				WithoutConnectionToken = false,
				ConnectionToken = string.Empty,
			}));
	}

	private static void InvokeValidate(OpenVSCodeServerOptions options)
	{
		// Validate is internal; call via reflection to keep the surface tight.
		var method = typeof(OpenVSCodeServerOptions).GetMethod("Validate", BindingFlags.Instance | BindingFlags.NonPublic);
		Assert.NotNull(method);
		try
		{
			method!.Invoke(options, Array.Empty<object>());
		}
		catch (TargetInvocationException tie) when (tie.InnerException is not null)
		{
			throw tie.InnerException;
		}
	}
}
