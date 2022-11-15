/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as uuid from 'uuid';
import * as util from 'util';
import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { ThrottledDelayer } from './util/async';
import { download } from './util/download';
import { GitpodExtensionContext, GitpodPluginModel } from 'gitpod-shared';
import { getVSCodeProductJson } from './util/serverConfig';
import { getVsixManifest, IRawGalleryQueryResult } from './util/extensionManagmentUtill';

async function validateExtensions(extensionsToValidate: { id: string; version?: string }[], linkToValidate: string[], token: vscode.CancellationToken) {
	const allUserExtensions = vscode.extensions.all.filter(ext => !ext.packageJSON['isBuiltin'] && !ext.packageJSON['isUserBuiltin']);

	const lookup = new Set<string>(extensionsToValidate.map(({ id }) => id));
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
			return {
				extensions: [],
				missingMachined: [],
				uninstalled: [],
				links: []
			};
		}
	}

	const validatedExtensions = new Set<string>();

	const galleryUrl: string | undefined = (await getVSCodeProductJson()).extensionsGallery?.serviceUrl;
	if (galleryUrl) {
		const queryResult: IRawGalleryQueryResult | undefined = await fetch(
			`${galleryUrl}/extensionquery`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json;api-version=3.0-preview.1',
					'Accept-Encoding': 'gzip'
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
				timeout: 2000
			}
		).then(resp => {
			if (!resp.ok) {
				console.error('Failed to query gallery service while validating gitpod.yml');
				return undefined;
			}
			return resp.json() as Promise<IRawGalleryQueryResult>;
		}, e => {
			console.error('Fetch failed while querying gallery service', e);
			return undefined;
		});

		if (token.isCancellationRequested) {
			return {
				extensions: [],
				missingMachined: [],
				uninstalled: [],
				links: []
			};
		}

		if (queryResult) {
			const galleryExtensions = queryResult.results[0].extensions;
			for (const galleryExt of galleryExtensions) {
				validatedExtensions.add(`${galleryExt.publisher.publisherName}.${galleryExt.extensionName}`);
			}
		}
	}

	const links = new Set<string>();
	for (const link of linkToValidate) {
		const downloadPath = path.join(os.tmpdir(), uuid.v4());
		try {
			await download(link, downloadPath, token, 10000);
			const manifest = await getVsixManifest(downloadPath);
			if (manifest.engines?.vscode) {
				links.add(link);
			}
		} catch (error) {
			console.error('Failed to validate vsix url', error);
		}

		if (token.isCancellationRequested) {
			return {
				extensions: [],
				missingMachined: [],
				uninstalled: [],
				links: []
			};
		}
	}

	return {
		extensions: [...validatedExtensions],
		missingMachined: [...missingMachined],
		uninstalled: [...uninstalled],
		links: [...links]
	};
}

export function registerExtensionManagement(context: GitpodExtensionContext): void {
	const { GitpodPluginModel, isYamlSeq, isYamlScalar } = context.config;
	const gitpodFileUri = vscode.Uri.file(path.join(context.info.getCheckoutLocation(), '.gitpod.yml'));

	async function modifyGipodPluginModel(unitOfWork: (model: GitpodPluginModel) => void): Promise<void> {
		let document: vscode.TextDocument | undefined;
		let content = '';
		try {
			await util.promisify(fs.access.bind(fs))(gitpodFileUri.fsPath, fs.constants.F_OK);
			document = await vscode.workspace.openTextDocument(gitpodFileUri);
			content = document.getText();
		} catch {
			/* no-op */
		}

		const model = new GitpodPluginModel(content);
		unitOfWork(model);
		const edit = new vscode.WorkspaceEdit();
		if (document) {
			edit.replace(gitpodFileUri, document.validateRange(new vscode.Range(
				document.positionAt(0),
				document.positionAt(content.length)
			)), String(model));
		} else {
			edit.createFile(gitpodFileUri, { overwrite: true });
			edit.insert(gitpodFileUri, new vscode.Position(0, 0), String(model));
		}
		await vscode.workspace.applyEdit(edit);
	}
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.extensions.addToConfig', (id: string) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_config',
			properties: { action: 'add' }
		});
		return modifyGipodPluginModel(model => model.add(id));
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.extensions.removeFromConfig', (id: string) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_config',
			properties: { action: 'remove' }
		});
		return modifyGipodPluginModel(model => model.remove(id));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('gitpod.extensions.installFromConfig', (id: string) => vscode.commands.executeCommand('workbench.extensions.installExtension', id, { donotSync: true })));

	const deprecatedUserExtensionMessage = 'user uploaded extensions are deprecated';
	const extensionNotFoundMessageSuffix = ' extension is not found in Open VSX';
	const invalidVSIXLinkMessageSuffix = ' does not point to a valid VSIX file';
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
					gitpodDiagnostics.set(gitpodFileUri, diagnostics);
				}
			}
			try {
				const toLink = new Map<string, vscode.Range>();
				const toFind = new Map<string, { version?: string; range: vscode.Range }>();
				let document: vscode.TextDocument | undefined;
				try {
					document = await vscode.workspace.openTextDocument(gitpodFileUri);
				} catch { }
				if (token.isCancellationRequested) {
					return;
				}
				const model = document && new GitpodPluginModel(document.getText());
				const extensions = model && model.document.getIn(['vscode', 'extensions'], true);
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
							}
						} catch { }
						if (link) {
							toLink.set(link.toString(), new vscode.Range(document.positionAt(item.range[0]), document.positionAt(item.range[1])));
						} else {
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
							resolveAllDeprecated.edit.delete(gitpodFileUri, diagnostic.range);
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

					if (token.isCancellationRequested) {
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

					for (const link of result.links) {
						toLink.delete(link);
					}
					for (const [link, range] of toLink) {
						const diagnostic = new vscode.Diagnostic(range, link + invalidVSIXLinkMessageSuffix, vscode.DiagnosticSeverity.Error);
						diagnostic.source = 'gitpod';
						pushDiagnostic(diagnostic);
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
		{ pattern: gitpodFileUri.fsPath },
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
				}
				return codeActions;
			}
		}));

	validateGitpodFile();
	context.subscriptions.push(gitpodDiagnostics);
	const gitpodFileWatcher = vscode.workspace.createFileSystemWatcher(gitpodFileUri.fsPath);
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
