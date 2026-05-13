// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.AspNetCore.Http;
using OpenVSCodeServer.Kestrel;
using Xunit;

namespace OpenVSCodeServer.Tests;

public class ProxyConnectionTokenTests
{
	[Fact]
	public void MergeConnectionToken_AppendsTokenWhenMissing()
	{
		var merged = OpenVSCodeServerProxy.MergeConnectionToken("foo=1", "secret");
		Assert.Equal("foo=1&tkn=secret", merged);
	}

	[Fact]
	public void MergeConnectionToken_AppendsTokenToEmptyQuery()
	{
		var merged = OpenVSCodeServerProxy.MergeConnectionToken(string.Empty, "secret");
		Assert.Equal("tkn=secret", merged);
	}

	[Fact]
	public void MergeConnectionToken_ReplacesCallerSuppliedToken()
	{
		var merged = OpenVSCodeServerProxy.MergeConnectionToken("foo=1&tkn=other&bar=2", "secret");
		Assert.Equal("foo=1&bar=2&tkn=secret", merged);
	}

	[Fact]
	public void MergeConnectionToken_NoToken_LeavesQueryAlone()
	{
		var merged = OpenVSCodeServerProxy.MergeConnectionToken("foo=1", connectionToken: null);
		Assert.Equal("foo=1", merged);
	}

	[Fact]
	public void MergeConnectionToken_UrlEncodesToken()
	{
		var merged = OpenVSCodeServerProxy.MergeConnectionToken(string.Empty, "tok en/with=special");
		// "/", "=" and " " are all reserved/special and must be percent-encoded.
		Assert.Equal("tkn=tok%20en%2Fwith%3Dspecial", merged);
	}

	[Fact]
	public void BuildUpstreamUri_AppendsToken()
	{
		var ctx = new DefaultHttpContext();
		ctx.Request.Path = "/ide/some/path";
		ctx.Request.QueryString = new QueryString("?reload=1");

		var uri = OpenVSCodeServerProxy.BuildUpstreamUri(
			new Uri("http://127.0.0.1:7000/"),
			ctx.Request,
			"/ide",
			websocket: false,
			connectionToken: "my-token");

		Assert.Equal("http", uri.Scheme);
		Assert.Equal("/ide/some/path", uri.AbsolutePath);
		Assert.Equal("?reload=1&tkn=my-token", uri.Query);
	}

	[Fact]
	public void BuildUpstreamUri_UsesWsSchemeForWebSockets()
	{
		var ctx = new DefaultHttpContext();
		ctx.Request.Path = "/ide/socket";

		var uri = OpenVSCodeServerProxy.BuildUpstreamUri(
			new Uri("http://127.0.0.1:7000/"),
			ctx.Request,
			"/ide",
			websocket: true,
			connectionToken: "abc");

		Assert.Equal("ws", uri.Scheme);
		Assert.Equal("/ide/socket", uri.AbsolutePath);
		Assert.Equal("?tkn=abc", uri.Query);
	}
}
