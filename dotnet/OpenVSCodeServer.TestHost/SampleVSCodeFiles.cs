// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See LICENSE.txt for license information.

using Microsoft.Extensions.Logging;
using OpenVSCodeServer.Kestrel;

namespace OpenVSCodeServer.TestHost;

/// <summary>
/// Configuration for the test-host's sample <see cref="IVSCodeFiles"/>. Points at a folder that
/// will be copied into each newly-created session's workspace as a starter project.
/// </summary>
internal sealed record SampleVSCodeFilesOptions(string SeedFolder);

/// <summary>
/// Minimal <see cref="IVSCodeFiles"/> used by the test host. On initialize it copies a seed
/// folder into the empty session workspace; on save it logs the change set so operators can see
/// the round-trip working end-to-end without wiring up a real backend.
/// </summary>
internal sealed class SampleVSCodeFiles : IVSCodeFiles
{
	private readonly ILogger<SampleVSCodeFiles> _logger;
	private readonly SampleVSCodeFilesOptions _options;

	public SampleVSCodeFiles(ILogger<SampleVSCodeFiles> logger, SampleVSCodeFilesOptions options)
	{
		_logger = logger;
		_options = options;
	}

	public Task InitializeAsync(VSCodeSessionContext context, CancellationToken cancellationToken)
	{
		var seed = _options.SeedFolder;
		if (!Directory.Exists(seed))
		{
			_logger.LogWarning(
				"Sample seed folder {Seed} does not exist; session {SessionId} will start with an empty workspace.",
				seed, context.SessionId);

			// Drop a placeholder README so the user lands on a non-empty workbench.
			File.WriteAllText(
				Path.Combine(context.WorkspaceFolder, "README.md"),
				$"# Empty session\n\nNo seed folder configured at `{seed}`.\nWrite some files here and watch SaveAsync get invoked.\n");
			return Task.CompletedTask;
		}

		CopyDirectory(seed, context.WorkspaceFolder);
		_logger.LogInformation(
			"Session {SessionId} seeded from {Seed} into {Folder}.",
			context.SessionId, seed, context.WorkspaceFolder);
		return Task.CompletedTask;
	}

	public Task SaveAsync(
		VSCodeSessionContext context,
		IReadOnlyCollection<VSCodeFileChange> changes,
		CancellationToken cancellationToken)
	{
		foreach (var change in changes)
		{
			_logger.LogInformation(
				"Session {SessionId} saved {Kind} {Path}.",
				context.SessionId, change.Kind, change.RelativePath);
		}
		return Task.CompletedTask;
	}

	private static void CopyDirectory(string source, string destination)
	{
		Directory.CreateDirectory(destination);
		foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
		{
			var rel = Path.GetRelativePath(source, file);
			var target = Path.Combine(destination, rel);
			Directory.CreateDirectory(Path.GetDirectoryName(target)!);
			File.Copy(file, target, overwrite: true);
		}
	}
}
