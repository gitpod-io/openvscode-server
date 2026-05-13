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

// Tiny landing page that links straight into the workbench. Lets `dotnet run` + open
// http://127.0.0.1:5000 land you on the editor in one click instead of having to remember
// the mount prefix.
var ideHref = pathPrefix.TrimEnd('/') + "/";
var indexHtml = $@"<!doctype html>
<html lang=""en"">
  <head>
    <meta charset=""utf-8"" />
    <title>OpenVSCode Server – Kestrel test host</title>
    <style>
      body {{ font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }}
      code {{ background: #f3f3f3; padding: 0 .25rem; border-radius: .25rem; }}
      a.cta {{ display: inline-block; margin-top: 1.5rem; padding: .6rem 1rem; background: #007acc; color: white; border-radius: .25rem; text-decoration: none; }}
      a.cta:hover {{ background: #005c99; }}
      ul {{ line-height: 1.7; }}
    </style>
  </head>
  <body>
    <h1>OpenVSCode Server – Kestrel test host</h1>
    <p>This page is served by <code>OpenVSCodeServer.TestHost</code>. The embedded VS Code is mounted at <code>{System.Net.WebUtility.HtmlEncode(ideHref)}</code>.</p>
    <a class=""cta"" href=""{System.Net.WebUtility.HtmlEncode(ideHref)}"">Open the editor →</a>
    <ul>
      <li>Workspace: <code>{System.Net.WebUtility.HtmlEncode(workspace)}</code></li>
      <li>Readiness probe: <a href=""/healthz"">/healthz</a></li>
    </ul>
  </body>
</html>";

app.MapGet("/", () => Results.Content(indexHtml, "text/html"));

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
