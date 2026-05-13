// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using OpenVSCodeServer.Kestrel;

var builder = WebApplication.CreateBuilder(args);

// Allow operators to override the bundled server with an existing install or to relocate the
// extraction directory without recompiling.
var workspace = GetArg(args, "--workspace")
	?? Environment.GetEnvironmentVariable("OPENVSCODE_WORKSPACE")
	?? Directory.GetCurrentDirectory();

var externalServerPath = GetArg(args, "--external-server-path")
	?? Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");

var pathPrefix = GetArg(args, "--path-prefix") ?? "/ide";

builder.Services.AddOpenVSCodeServer(options =>
{
	options.WorkspaceFolder = workspace;
	options.ExternalServerPath = externalServerPath;
	options.WithoutConnectionToken = true;
});

var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapGet("/", (HttpContext context) =>
{
	context.Response.Redirect(pathPrefix.TrimEnd('/') + "/");
	return Task.CompletedTask;
});

app.MapOpenVSCodeServer(pathPrefix);

app.Logger.LogInformation("Mounting OpenVSCode Server at {Prefix}. Workspace = {Workspace}", pathPrefix, workspace);

app.Run();

static string? GetArg(string[] args, string name)
{
	for (var i = 0; i < args.Length; i++)
	{
		if (args[i] == name && i + 1 < args.Length)
		{
			return args[i + 1];
		}
		if (args[i].StartsWith(name + "=", StringComparison.Ordinal))
		{
			return args[i][(name.Length + 1)..];
		}
	}
	return null;
}
