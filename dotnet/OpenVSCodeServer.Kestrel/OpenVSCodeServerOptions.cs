// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

namespace OpenVSCodeServer.Kestrel;

/// <summary>
/// Options that control how the embedded OpenVSCode Server is extracted and launched.
/// </summary>
public sealed class OpenVSCodeServerOptions
{
	/// <summary>
	/// Workspace folder opened by VS Code when the user first connects.
	/// Defaults to the current working directory of the host process.
	/// </summary>
	public string? WorkspaceFolder { get; set; }

	/// <summary>
	/// Directory used to extract the embedded distribution. Defaults to a sub-folder of
	/// <see cref="Path.GetTempPath"/> derived from a hash of the bundled archive so that
	/// multiple library versions can coexist on the same machine.
	/// </summary>
	public string? ExtractionDirectory { get; set; }

	/// <summary>
	/// If set, points at an existing openvscode-server installation on disk. When non-null
	/// the embedded resource is ignored entirely. The directory must contain
	/// <c>out/server-main.js</c> and a <c>node</c> binary at the root.
	/// </summary>
	public string? ExternalServerPath { get; set; }

	/// <summary>
	/// Optional connection token used to gate access to the IDE. Equivalent to the upstream
	/// <c>--connection-token</c> flag. Ignored when <see cref="WithoutConnectionToken"/> is true.
	/// </summary>
	public string? ConnectionToken { get; set; }

	/// <summary>
	/// Forwarded to the upstream <c>--without-connection-token</c> flag. Defaults to true so
	/// that the IDE is immediately reachable from the parent ASP.NET Core application (which
	/// is expected to handle authentication at its own layer).
	/// </summary>
	public bool WithoutConnectionToken { get; set; } = true;

	/// <summary>
	/// Loopback address the child server binds to. Almost always <c>127.0.0.1</c>; Kestrel is the
	/// outer-facing listener.
	/// </summary>
	public string Host { get; set; } = "127.0.0.1";

	/// <summary>
	/// Port the child server binds to. When null an ephemeral port is allocated automatically.
	/// </summary>
	public int? Port { get; set; }

	/// <summary>
	/// How long to wait for the child server to print its "Web UI available" banner before
	/// declaring startup a failure.
	/// </summary>
	public TimeSpan StartupTimeout { get; set; } = TimeSpan.FromSeconds(60);

	/// <summary>
	/// Additional command-line arguments forwarded verbatim to <c>server-main.js</c>.
	/// </summary>
	public IList<string> AdditionalArguments { get; } = new List<string>();

	/// <summary>
	/// Path prefix that Kestrel exposes the IDE under (e.g. <c>/ide</c>). Set automatically by
	/// <see cref="OpenVSCodeServerEndpointRouteBuilderExtensions.MapOpenVSCodeServer"/>.
	/// </summary>
	public string PathPrefix { get; internal set; } = "/";

	/// <summary>
	/// Environment variables to set on the child process (in addition to the inherited environment).
	/// </summary>
	public IDictionary<string, string?> EnvironmentOverrides { get; } =
		new Dictionary<string, string?>(StringComparer.Ordinal);
}
