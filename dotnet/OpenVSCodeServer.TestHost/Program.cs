// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using System.Net;
using OpenVSCodeServer.Kestrel;
using OpenVSCodeServer.TestHost;

var builder = WebApplication.CreateBuilder(args);

// Allow operators to override the bundled server with an existing install or to relocate the
// extraction directory without recompiling.
var workspace = GetArg(args, "--workspace")
	?? Environment.GetEnvironmentVariable("OPENVSCODE_WORKSPACE")
	?? Directory.GetCurrentDirectory();

var externalServerPath = GetArg(args, "--external-server-path")
	?? Environment.GetEnvironmentVariable("OPENVSCODE_EXTERNAL_PATH");

var pathPrefix = GetArg(args, "--path-prefix") ?? "/ide";

var sampleSeedFolder = GetArg(args, "--sample-folder")
	?? Environment.GetEnvironmentVariable("OPENVSCODE_SAMPLE_FOLDER")
	?? Path.Combine(AppContext.BaseDirectory, "SampleWorkspace");

builder.Services.AddOpenVSCodeServer(options =>
{
	options.WorkspaceFolder = workspace;
	options.ExternalServerPath = externalServerPath;
	options.WithoutConnectionToken = true;
});

// Register a sample IVSCodeFiles implementation that copies a seed folder into the temp workspace
// on session creation and logs any saves to stdout. Lets `dotnet run` produce a working
// per-session IDE end-to-end without the operator having to write code first.
builder.Services.AddSingleton(new SampleVSCodeFilesOptions(sampleSeedFolder));
builder.Services.AddVSCodeFiles<SampleVSCodeFiles>();

var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

// Tiny landing page that embeds the workbench in an iframe so `dotnet run` plus a click lands
// the user in the editor without leaving the page. The iframe sits inside the host page at
// 80vw × 80vh so it's obvious which part is the IDE vs. the host shell.
var ideHref = pathPrefix.TrimEnd('/') + "/";
var indexHtml = $@"<!doctype html>
<html lang=""en"">
  <head>
    <meta charset=""utf-8"" />
    <title>OpenVSCode Server – Kestrel test host</title>
    <style>
      body {{ font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; color: #1a1a1a; background: #f5f5f5; }}
      .container {{ max-width: 80vw; margin: 0 auto; }}
      header {{ display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }}
      header h1 {{ font-size: 1.25rem; margin: 0; }}
      header .meta {{ font-size: .85rem; color: #555; }}
      code {{ background: #e8e8e8; padding: 0 .25rem; border-radius: .25rem; }}
      button, a.cta {{ display: inline-block; padding: .5rem .9rem; background: #007acc; color: white; border: none; border-radius: .25rem; text-decoration: none; cursor: pointer; font-size: .9rem; }}
      button:hover, a.cta:hover {{ background: #005c99; }}
      button:disabled {{ background: #888; cursor: progress; }}
      .actions {{ display: flex; gap: .5rem; flex-wrap: wrap; }}
      #frame-wrap {{ width: 80vw; height: 80vh; margin-top: 1rem; border: 1px solid #ccc; border-radius: .25rem; background: #fff; overflow: hidden; }}
      #frame-wrap iframe {{ width: 100%; height: 100%; border: 0; display: block; }}
      #frame-placeholder {{ display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: #888; font-size: .95rem; }}
      #status {{ margin-top: .5rem; font-size: .85rem; color: #555; min-height: 1.2em; }}
    </style>
  </head>
  <body>
    <div class=""container"">
      <header>
        <h1>OpenVSCode Server – Kestrel test host</h1>
        <span class=""meta"">Mounted at <code>{System.Net.WebUtility.HtmlEncode(ideHref)}</code></span>
      </header>
      <p>This page is served by <code>OpenVSCodeServer.TestHost</code>. Open the global editor or spin up a fresh per-request session — both load below.</p>
      <div class=""actions"">
        <a class=""cta"" href=""#"" onclick=""openGlobal(); return false;"">Open global editor</a>
        <button id=""sessionBtn"" onclick=""createSession()"">New session</button>
        <a class=""cta"" href=""/healthz"" target=""_blank"" rel=""noopener"">/healthz</a>
      </div>
      <div id=""status""></div>
      <div id=""frame-wrap"">
        <div id=""frame-placeholder"">Click <em>Open global editor</em> or <em>New session</em> to embed the IDE here.</div>
      </div>
    </div>
    <script>
      const idePath = {System.Text.Json.JsonSerializer.Serialize(ideHref)};
      const frameWrap = document.getElementById('frame-wrap');
      const status = document.getElementById('status');
      const btn = document.getElementById('sessionBtn');

      function show(url, label) {{
        frameWrap.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.title = label;
        frameWrap.appendChild(iframe);
        status.textContent = 'Loaded: ' + url;
      }}

      function openGlobal() {{
        show(idePath, 'OpenVSCode Server (global workspace)');
      }}

      async function createSession() {{
        btn.disabled = true;
        status.textContent = 'Creating session…';
        try {{
          const resp = await fetch('/sessions', {{
            method: 'POST',
            headers: {{ 'Content-Type': 'application/json' }},
            body: JSON.stringify({{ state: {{ source: 'test-host-landing' }} }}),
          }});
          if (!resp.ok) {{
            const text = await resp.text();
            throw new Error(resp.status + ' ' + text);
          }}
          const session = await resp.json();
          show(session.ideUrl, 'OpenVSCode Server (session ' + session.sessionId + ')');
          status.textContent = 'Session ' + session.sessionId + ' – ' + session.workspaceFolder;
        }} catch (err) {{
          status.textContent = 'Failed to create session: ' + err.message;
        }} finally {{
          btn.disabled = false;
        }}
      }}
    </script>
  </body>
</html>";

app.MapGet("/", () => Results.Content(indexHtml, "text/html"));

app.MapOpenVSCodeServer(pathPrefix)
	.WithSessions("/sessions");

app.Logger.LogInformation("Mounting OpenVSCode Server at {Prefix}. Workspace = {Workspace}", pathPrefix, workspace);
app.Logger.LogInformation("Sample session seed folder = {Seed}", sampleSeedFolder);

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
