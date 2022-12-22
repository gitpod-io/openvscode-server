/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import fetch from 'node-fetch';
import { ThrottledDelayer } from './util/async';
import { download } from './util/download';
import { GitpodExtensionContext, isYamlScalar, isYamlSeq } from 'gitpod-shared';
import { getVSCodeProductJson } from './util/serverConfig';
import { getVsixManifest, IRawGalleryQueryResult } from './util/extensionManagmentUtill';

const downloadedCache = new Set<string>();

function getLinkDownloadFile(link: string) {
	const hash = crypto.createHash('md5').update(link).digest('hex');
	const downloadPath = path.join(os.tmpdir(), `tmp_vsix_${hash}`);
	return downloadPath;
}

interface ValidateResults {
	extensions: string[];
	missingMachined: string[];
	uninstalled: string[];
	linkExtMap: Record<string, string>;
}

async function validateExtensions(extensionsToValidate: { id: string; version?: string }[], linkToValidate: string[], token: vscode.CancellationToken): Promise<ValidateResults | undefined> {
	const allUserExtensions = vscode.extensions.all.filter(ext => !ext.packageJSON['isBuiltin'] && !ext.packageJSON['isUserBuiltin']);

	const validatedExtensions = new Set<string>();

	const galleryUrl: string | undefined = (await getVSCodeProductJson()).extensionsGallery?.serviceUrl;
	if (galleryUrl) {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30000);
		token.onCancellationRequested(() => controller.abort());
		const queryResult: IRawGalleryQueryResult | undefined = await fetch(
			`${galleryUrl}/extensionquery`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json;api-version=3.0-preview.1',
					'Accept-Encoding': 'gzip',
					'X-Market-Client-Id': `VSCode ${vscode.version}`
				},
				body: JSON.stringify({
					filters: [{
						criteria: [
							...extensionsToValidate.map(ext => ({ filterType: 7, value: ext.id })),
							{ filterType: 8, value: 'Microsoft.VisualStudio.Code' },
							{ filterType: 12, value: '4096' }
						],
						pageNumber: 1,
						pageSize: extensionsToValidate.length,
						sortBy: 0,
						sortOrder: 0
					}],
					flags: 950
				}),
				// @ts-ignore
				signal: controller.signal,
			}
		).then(resp => {
			if (!resp.ok) {
				console.error('Failed to query gallery service while validating gitpod.yml');
				return undefined;
			}
			return resp.json() as Promise<IRawGalleryQueryResult>;
		}, e => {
			if (e.name === 'AbortError') {
				return undefined;
			}
			console.error('Fetch failed while querying gallery service', e);
			return undefined;
		});

		if (token.isCancellationRequested) {
			return undefined;
		}

		if (queryResult) {
			const galleryExtensions = queryResult.results[0].extensions;
			for (const galleryExt of galleryExtensions) {
				validatedExtensions.add(`${galleryExt.publisher.publisherName}.${galleryExt.extensionName}`);
			}
		}
	}

	const downloadResult = await Promise.allSettled(linkToValidate.map(link => {
		const downloadPath = getLinkDownloadFile(link);
		if (downloadedCache.has(link)) {
			return Promise.resolve(downloadPath);
		}
		return download(link, downloadPath, token, 30000).then(() => {
			downloadedCache.add(link);
			return downloadPath;
		});
	}));

	if (token.isCancellationRequested) {
		return undefined;
	}

	const linkExtMap = new Map<string, string>();
	for (let i = 0; i < linkToValidate.length; i++) {
		const link = linkToValidate[i];
		const result = downloadResult[i];
		if (result.status === 'rejected') {
			console.error('Failed to download vsix url ' + link, result.reason);
		} else {
			try {
				const manifest = await getVsixManifest(result.value);
				if (manifest.engines?.vscode) {
					const extId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
					linkExtMap.set(link, extId);
				}
			} catch (e) {
				console.error('Failed to validate vsix from url ' + link, e);
			}
		}
	}

	if (token.isCancellationRequested) {
		return undefined;
	}

	const lookup = new Set<string>([...extensionsToValidate.map(({ id }) => id), ...linkExtMap.values()]);
	const uninstalled = new Set<string>([...lookup]);
	lookup.add('github.vscode-pull-request-github');
	const missingMachined = new Set<string>();
	for (const extension of allUserExtensions) {
		const id = extension.id.toLowerCase();
		const packageBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'package.json'));
		const rawPackage = JSON.parse(packageBytes.toString());
		const isMachineScoped = !!rawPackage['__metadata']?.['isMachineScoped'];
		uninstalled.delete(id);

		if (isMachineScoped && !lookup.has(id)) {
			missingMachined.add(id);
		}

		if (token.isCancellationRequested) {
			return undefined;
		}
	}

	return {
		extensions: [...validatedExtensions],
		missingMachined: [...missingMachined],
		uninstalled: [...uninstalled],
		linkExtMap: Object.fromEntries(linkExtMap),
	};
}

export function registerExtensionManagement(context: GitpodExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.extensions.addToConfig', async (id: string) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_config',
			properties: { action: 'add' }
		});
		const yaml = await context.gitpodYml.getYaml();
		yaml.add(id);
		await context.gitpodYml.writeContent(yaml.toString());
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.extensions.removeFromConfig', async (id: string) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_config',
			properties: { action: 'remove' }
		});
		const yaml = await context.gitpodYml.getYaml();
		yaml.remove(id);
		await context.gitpodYml.writeContent(yaml.toString());
	}));

	context.subscriptions.push(vscode.commands.registerCommand('gitpod.extensions.installFromConfig', (id: string) => vscode.commands.executeCommand('workbench.extensions.installExtension', id, { donotSync: true })));

	const deprecatedUserExtensionMessage = 'user uploaded extensions are deprecated';
	const extensionNotFoundMessageSuffix = ' extension is not found in Open VSX';
	const invalidVSIXLinkMessageSuffix = ' does not point to a valid VSIX file';
	const invalidVSIXLinkNotInstalledMessageSuffix = ' VSIX file is not installed yet';
	const missingExtensionMessageSuffix = ' extension is not synced, but not added in .gitpod.yml';
	const uninstalledExtensionMessageSuffix = ' extension is not installed, but not removed from .gitpod.yml';
	const gitpodDiagnostics = vscode.languages.createDiagnosticCollection('gitpod');
	const validateGitpodFileDelayer = new ThrottledDelayer(150);
	const validateExtensionseDelayer = new ThrottledDelayer(1000); /** it can be very expensive for links to big extensions */
	let validateGitpodFileTokenSource: vscode.CancellationTokenSource | undefined;
	let resolveAllDeprecated: vscode.CodeAction | undefined;
	function validateGitpodFile(): void {
		resolveAllDeprecated = undefined;
		if (validateGitpodFileTokenSource) {
			validateGitpodFileTokenSource.cancel();
		}
		validateGitpodFileTokenSource = new vscode.CancellationTokenSource();
		const token = validateGitpodFileTokenSource.token;
		validateGitpodFileDelayer.trigger(async () => {
			if (token.isCancellationRequested) {
				return;
			}
			let diagnostics: vscode.Diagnostic[] | undefined;
			function pushDiagnostic(diagnostic: vscode.Diagnostic): void {
				if (!diagnostics) {
					diagnostics = [];
				}
				diagnostics.push(diagnostic);
			}
			function publishDiagnostics(): void {
				if (!token.isCancellationRequested) {
					gitpodDiagnostics.set(context.gitpodYml.uri, diagnostics);
				}
			}
			try {
				const toLink = new Map<string, vscode.Range>();
				const toFind = new Map<string, { version?: string; range: vscode.Range }>();
				let document: vscode.TextDocument | undefined;
				try {
					document = await vscode.workspace.openTextDocument(context.gitpodYml.uri);
				} catch { }
				if (token.isCancellationRequested) {
					return;
				}
				const model = await context.gitpodYml.getYaml();
				if (token.isCancellationRequested) {
					return;
				}
				const extensions = model.document.getIn(['vscode', 'extensions'], true);
				if (document && extensions && isYamlSeq(extensions)) {
					resolveAllDeprecated = new vscode.CodeAction('Resolve all against Open VSX.', vscode.CodeActionKind.QuickFix);
					resolveAllDeprecated.diagnostics = [];
					resolveAllDeprecated.isPreferred = true;
					for (let i = 0; i < extensions.items.length; i++) {
						const item = extensions.items[i];
						if (!isYamlScalar(item) || !item.range) {
							continue;
						}
						const extension = item.value;
						if (!(typeof extension === 'string')) {
							continue;
						}
						let link: vscode.Uri | undefined;
						try {
							link = vscode.Uri.parse(extension.trim(), true);
							if (link.scheme !== 'http' && link.scheme !== 'https') {
								link = undefined;
							} else {
								toLink.set(link.toString(), new vscode.Range(document.positionAt(item.range[0]), document.positionAt(item.range[1])));
							}
						} catch { }
						if (!link) {
							const [idAndVersion, hash] = extension.trim().split(':', 2);
							if (hash) {
								const hashOffset = item.range[0] + extension.indexOf(':');
								const range = new vscode.Range(document.positionAt(hashOffset), document.positionAt(item.range[1]));

								const diagnostic = new vscode.Diagnostic(range, deprecatedUserExtensionMessage, vscode.DiagnosticSeverity.Warning);
								diagnostic.source = 'gitpod';
								diagnostic.tags = [vscode.DiagnosticTag.Deprecated];
								pushDiagnostic(diagnostic);
								resolveAllDeprecated.diagnostics.unshift(diagnostic);
							}
							const [id, version] = idAndVersion.split('@', 2);
							toFind.set(id.toLowerCase(), { version, range: new vscode.Range(document.positionAt(item.range[0]), document.positionAt(item.range[1])) });
						}
					}
					if (resolveAllDeprecated.diagnostics.length) {
						resolveAllDeprecated.edit = new vscode.WorkspaceEdit();
						for (const diagnostic of resolveAllDeprecated.diagnostics) {
							resolveAllDeprecated.edit.delete(context.gitpodYml.uri, diagnostic.range);
						}
					} else {
						resolveAllDeprecated = undefined;
					}
					publishDiagnostics();
				}

				await validateExtensionseDelayer.trigger(async () => {
					if (token.isCancellationRequested) {
						return;
					}

					const extensionsToValidate = [...toFind.entries()].map(([id, { version }]) => ({ id, version }));
					const linksToValidate = [...toLink.keys()];
					const result = await validateExtensions(extensionsToValidate, linksToValidate, token);
					if (!result) {
						return;
					}

					const notFound = new Set([...toFind.keys()]);
					for (const id of result.extensions) {
						notFound.delete(id.toLowerCase());
					}
					for (const id of notFound) {
						const { range, version } = toFind.get(id)!;
						let message = id;
						if (version) {
							message += '@' + version;
						}
						message += extensionNotFoundMessageSuffix;
						const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
						diagnostic.source = 'gitpod';
						pushDiagnostic(diagnostic);
					}

					for (const [link, range] of toLink) {
						const extId = result.linkExtMap[link];
						if (!extId) {
							const diagnostic = new vscode.Diagnostic(range, link + invalidVSIXLinkMessageSuffix, vscode.DiagnosticSeverity.Error);
							diagnostic.source = 'gitpod';
							pushDiagnostic(diagnostic);
						} else if (result.uninstalled.includes(extId)) {
							const diagnostic = new vscode.Diagnostic(range, link + invalidVSIXLinkNotInstalledMessageSuffix, vscode.DiagnosticSeverity.Warning);
							diagnostic.source = 'gitpod';
							pushDiagnostic(diagnostic);
						}
					}

					for (const id of result.missingMachined) {
						const diagnostic = new vscode.Diagnostic(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)), id + missingExtensionMessageSuffix, vscode.DiagnosticSeverity.Warning);
						diagnostic.source = 'gitpod';
						pushDiagnostic(diagnostic);
					}

					for (const id of result.uninstalled) {
						if (notFound.has(id)) {
							continue;
						}
						const extension = toFind.get(id);
						if (extension) {
							let message = id;
							if (extension.version) {
								message += '@' + extension.version;
							}
							message += uninstalledExtensionMessageSuffix;
							const diagnostic = new vscode.Diagnostic(extension.range, message, vscode.DiagnosticSeverity.Warning);
							diagnostic.source = 'gitpod';
							pushDiagnostic(diagnostic);
						}
					}
				});
			} finally {
				publishDiagnostics();
			}
		});
	}

	context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
		{ pattern: context.gitpodYml.uri.fsPath },
		{
			provideCodeActions: (document, _, context) => {
				const codeActions: vscode.CodeAction[] = [];
				for (const diagnostic of context.diagnostics) {
					if (diagnostic.message === deprecatedUserExtensionMessage) {
						if (resolveAllDeprecated) {
							codeActions.push(resolveAllDeprecated);
						}
						const codeAction = new vscode.CodeAction('Resolve against Open VSX.', vscode.CodeActionKind.QuickFix);
						codeAction.diagnostics = [diagnostic];
						codeAction.isPreferred = false;
						const singleEdit = new vscode.WorkspaceEdit();
						singleEdit.delete(document.uri, diagnostic.range);
						codeAction.edit = singleEdit;
						codeActions.push(codeAction);
					}
					const notFoundIndex = diagnostic.message.indexOf(extensionNotFoundMessageSuffix);
					if (notFoundIndex !== -1) {
						const id = diagnostic.message.substr(0, notFoundIndex);
						codeActions.push(createRemoveFromConfigCodeAction(id, diagnostic, document));
						codeActions.push(createSearchExtensionCodeAction(id, diagnostic));
					}
					const missingIndex = diagnostic.message.indexOf(missingExtensionMessageSuffix);
					if (missingIndex !== -1) {
						const id = diagnostic.message.substr(0, missingIndex);
						codeActions.push(createAddToConfigCodeAction(id, diagnostic));
						codeActions.push(createUninstallExtensionCodeAction(id, diagnostic));
					}
					const uninstalledIndex = diagnostic.message.indexOf(uninstalledExtensionMessageSuffix);
					if (uninstalledIndex !== -1) {
						const id = diagnostic.message.substr(0, uninstalledIndex);
						codeActions.push(createRemoveFromConfigCodeAction(id, diagnostic, document));
						codeActions.push(createInstallFromConfigCodeAction(id, diagnostic));
					}
					const invalidVSIXIndex = diagnostic.message.indexOf(invalidVSIXLinkMessageSuffix);
					if (invalidVSIXIndex !== -1) {
						const link = diagnostic.message.substr(0, invalidVSIXIndex);
						codeActions.push(createRemoveFromConfigCodeAction(link, diagnostic, document));
					}
					const uninstalledVSIXIndex = diagnostic.message.indexOf(invalidVSIXLinkNotInstalledMessageSuffix);
					if (uninstalledVSIXIndex !== -1) {
						const link = diagnostic.message.substr(0, uninstalledVSIXIndex);
						codeActions.push(createURLInstallFromConfigCodeAction(link, vscode.Uri.parse(getLinkDownloadFile(link)), diagnostic));
					}
				}
				return codeActions;
			}
		}));

	validateGitpodFile();
	context.subscriptions.push(gitpodDiagnostics);
	const gitpodFileWatcher = vscode.workspace.createFileSystemWatcher(context.gitpodYml.uri.fsPath);
	context.subscriptions.push(gitpodFileWatcher);
	context.subscriptions.push(gitpodFileWatcher.onDidCreate(() => validateGitpodFile()));
	context.subscriptions.push(gitpodFileWatcher.onDidChange(() => validateGitpodFile()));
	context.subscriptions.push(gitpodFileWatcher.onDidDelete(() => validateGitpodFile()));
	context.subscriptions.push(vscode.extensions.onDidChange(() => validateGitpodFile()));
}

function createSearchExtensionCodeAction(id: string, diagnostic: vscode.Diagnostic) {
	const title = `Search for ${id} in Open VSX.`;
	const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	codeAction.diagnostics = [diagnostic];
	codeAction.isPreferred = true;
	codeAction.command = {
		title: title,
		command: 'workbench.extensions.search',
		arguments: ['@id:' + id]
	};
	return codeAction;
}

function createAddToConfigCodeAction(id: string, diagnostic: vscode.Diagnostic) {
	const title = `Add ${id} extension to .gitpod.yml.`;
	const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	codeAction.diagnostics = [diagnostic];
	codeAction.isPreferred = true;
	codeAction.command = {
		title: title,
		command: 'gitpod.extensions.addToConfig',
		arguments: [id]
	};
	return codeAction;
}

function createRemoveFromConfigCodeAction(id: string, diagnostic: vscode.Diagnostic, document: vscode.TextDocument): vscode.CodeAction {
	const title = `Remove ${id} extension from .gitpod.yml.`;
	const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	codeAction.diagnostics = [diagnostic];
	codeAction.isPreferred = true;
	codeAction.command = {
		title: title,
		command: 'gitpod.extensions.removeFromConfig',
		arguments: [document.getText(diagnostic.range)]
	};
	return codeAction;
}

function createInstallFromConfigCodeAction(id: string, diagnostic: vscode.Diagnostic) {
	const title = `Install ${id} extension from .gitpod.yml.`;
	const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	codeAction.diagnostics = [diagnostic];
	codeAction.isPreferred = false;
	codeAction.command = {
		title: title,
		command: 'gitpod.extensions.installFromConfig',
		arguments: [id]
	};
	return codeAction;
}

function createURLInstallFromConfigCodeAction(id: string, url: vscode.Uri, diagnostic: vscode.Diagnostic) {
	const title = `Install ${id} extension from .gitpod.yml.`;
	const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	codeAction.diagnostics = [diagnostic];
	codeAction.isPreferred = false;
	codeAction.command = {
		title: title,
		command: 'gitpod.extensions.installFromConfig',
		arguments: [url]
	};
	return codeAction;
}

function createUninstallExtensionCodeAction(id: string, diagnostic: vscode.Diagnostic) {
	const title = `Uninstall ${id} extension.`;
	const codeAction = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	codeAction.diagnostics = [diagnostic];
	codeAction.isPreferred = false;
	codeAction.command = {
		title: title,
		command: 'workbench.extensions.uninstallExtension',
		arguments: [id]
	};
	return codeAction;
}
