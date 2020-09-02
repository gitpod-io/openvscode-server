/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vscode-dts/vscode.d.ts'/>

import { GitpodExtensionContext, registerTasks, setupGitpodContext, registerIpcHookCli } from 'gitpod-shared';
import * as path from 'path';
import * as vscode from 'vscode';
import { configureMachineSettings } from './machineSettings';
import { observePortsStatus, registerPortCommands, tunnelPorts } from './ports';
import { GitpodPortViewProvider } from './portViewProvider';
import { initializeRemoteExtensions, installInitialExtensions, ISyncExtension } from './remoteExtensionInit';

let gitpodContext: GitpodExtensionContext | undefined;
export async function activate(context: vscode.ExtensionContext) {
	gitpodContext = await setupGitpodContext(context);
	if (!gitpodContext) {
		return;
	}

	registerTasks(gitpodContext);
	installInitialExtensions(gitpodContext);

	registerPortCommands(gitpodContext);
	const portViewProvider = new GitpodPortViewProvider(gitpodContext);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(GitpodPortViewProvider.viewType, portViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));

	const [onPortUpdate, disposePortObserve] = observePortsStatus(gitpodContext!);
	context.subscriptions.push(disposePortObserve);
	let initial = true;
	context.subscriptions.push(onPortUpdate.event(portList => {
		const promise = configureMachineSettings(gitpodContext!, portList);
		if (initial) {
			initial = false;
			promise.then(() => tunnelPorts(portList));
		}
		portViewProvider.updatePortsStatus(portList);
	}));

	// We are moving the heartbeat to gitpod-desktop extension,
	// so we register a command to cancel the heartbeat on the gitpod-remote extension
	// and then gitpod-desktop will take care of it.
	const toDispose = registerHearbeat(gitpodContext);
	context.subscriptions.push(toDispose);
	context.subscriptions.push(vscode.commands.registerCommand('__gitpod.cancelGitpodRemoteHeartbeat', () => {
		toDispose.dispose();
		gitpodContext?.logger.info('__gitpod.cancelGitpodRemoteHeartbeat command executed');
		return true;
	}));

	registerCLI(gitpodContext);
	// configure task terminals if Gitpod Code Server is running
	if (process.env.GITPOD_THEIA_PORT) {
		registerIpcHookCli(gitpodContext);
	}

	// For port tunneling we rely on Remote SSH capabilities
	// and gitpod.gitpod to disable auto tunneling from the current local machine.
	vscode.commands.executeCommand('gitpod.api.autoTunnel', gitpodContext.info.getGitpodHost(), gitpodContext.info.getInstanceId(), false);

	// For collecting logs, will be called by gitpod-desktop extension;
	context.subscriptions.push(vscode.commands.registerCommand('__gitpod.getGitpodRemoteLogsUri', () => {
		return context.logUri;
	}));

	// Initialize remote extensions
	context.subscriptions.push(vscode.commands.registerCommand('__gitpod.initializeRemoteExtensions', (extensions: ISyncExtension[]) => initializeRemoteExtensions(extensions, gitpodContext!)));

	// TODO
	// - auth?
	// - .gitpod.yml validations
	// - add to .gitpod.yml command
	// - cli integration
	//   - git credential helper
	await gitpodContext.active;
}

export function deactivate() {
	if (!gitpodContext) {
		return;
	}
	return gitpodContext.dispose();
}

/**
 * configure CLI in regular terminals
 */
export function registerCLI(context: GitpodExtensionContext): void {
	context.environmentVariableCollection.replace('EDITOR', 'code');
	context.environmentVariableCollection.replace('VISUAL', 'code');
	context.environmentVariableCollection.replace('GP_OPEN_EDITOR', 'code');
	context.environmentVariableCollection.replace('GIT_EDITOR', 'code --wait');
	context.environmentVariableCollection.replace('GP_PREVIEW_BROWSER', `${process.execPath} ${path.join(__dirname, 'cli.js')} --preview`);
	context.environmentVariableCollection.replace('GP_EXTERNAL_BROWSER', 'code --openExternal');

	const ipcHookCli = context.ipcHookCli;
	if (!ipcHookCli) {
		return;
	}
	context.environmentVariableCollection.replace('GITPOD_REMOTE_CLI_IPC', ipcHookCli);
}

export function registerHearbeat(context: GitpodExtensionContext): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	let lastActivity = 0;
	const updateLastActivitiy = () => {
		lastActivity = new Date().getTime();
	};
	const sendHeartBeat = async (wasClosed?: true) => {
		const suffix = wasClosed ? 'was closed heartbeat' : 'heartbeat';
		if (wasClosed) {
			context.logger.trace('sending ' + suffix);
		}
		try {
			await context.gitpod.server.sendHeartBeat({ instanceId: context.info.getInstanceId(), wasClosed });
			if (wasClosed) {
				context.fireAnalyticsEvent({ eventName: 'ide_close_signal', properties: { clientKind: 'vscode' } });
			}
		} catch (err) {
			context.logger.error(`failed to send ${suffix}:`, err);
			console.error(`failed to send ${suffix}`, err);
		}
	};
	sendHeartBeat();
	if (!context.devMode) {
		const sendCloseHeartbeat = () => sendHeartBeat(true);
		context.pendingWillCloseSocket.push(sendCloseHeartbeat);
		disposables.push({
			dispose() {
				const idx = context.pendingWillCloseSocket.indexOf(sendCloseHeartbeat);
				if (idx >= 0) {
					context.pendingWillCloseSocket.splice(idx, 1);
				}
			}
		});
	}

	const activityInterval = 10000;
	const heartBeatHandle = setInterval(() => {
		if (lastActivity + activityInterval < new Date().getTime()) {
			// no activity, no heartbeat
			return;
		}
		sendHeartBeat();
	}, activityInterval);

	disposables.push(
		{
			dispose() {
				clearInterval(heartBeatHandle);
			}
		},
		vscode.window.onDidChangeActiveTextEditor(updateLastActivitiy),
		vscode.window.onDidChangeVisibleTextEditors(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorSelection(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorVisibleRanges(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorOptions(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorViewColumn(updateLastActivitiy),
		vscode.window.onDidChangeActiveTerminal(updateLastActivitiy),
		vscode.window.onDidOpenTerminal(updateLastActivitiy),
		vscode.window.onDidCloseTerminal(updateLastActivitiy),
		vscode.window.onDidChangeTerminalState(updateLastActivitiy),
		vscode.window.onDidChangeWindowState(updateLastActivitiy),
		vscode.window.onDidChangeActiveColorTheme(updateLastActivitiy),
		vscode.authentication.onDidChangeSessions(updateLastActivitiy),
		vscode.debug.onDidChangeActiveDebugSession(updateLastActivitiy),
		vscode.debug.onDidStartDebugSession(updateLastActivitiy),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(updateLastActivitiy),
		vscode.debug.onDidTerminateDebugSession(updateLastActivitiy),
		vscode.debug.onDidChangeBreakpoints(updateLastActivitiy),
		vscode.extensions.onDidChange(updateLastActivitiy),
		vscode.languages.onDidChangeDiagnostics(updateLastActivitiy),
		vscode.tasks.onDidStartTask(updateLastActivitiy),
		vscode.tasks.onDidStartTaskProcess(updateLastActivitiy),
		vscode.tasks.onDidEndTask(updateLastActivitiy),
		vscode.tasks.onDidEndTaskProcess(updateLastActivitiy),
		vscode.workspace.onDidChangeWorkspaceFolders(updateLastActivitiy),
		vscode.workspace.onDidOpenTextDocument(updateLastActivitiy),
		vscode.workspace.onDidCloseTextDocument(updateLastActivitiy),
		vscode.workspace.onDidChangeTextDocument(updateLastActivitiy),
		vscode.workspace.onDidSaveTextDocument(updateLastActivitiy),
		vscode.workspace.onDidChangeNotebookDocument(updateLastActivitiy),
		vscode.workspace.onDidSaveNotebookDocument(updateLastActivitiy),
		vscode.workspace.onDidOpenNotebookDocument(updateLastActivitiy),
		vscode.workspace.onDidCloseNotebookDocument(updateLastActivitiy),
		vscode.workspace.onWillCreateFiles(updateLastActivitiy),
		vscode.workspace.onDidCreateFiles(updateLastActivitiy),
		vscode.workspace.onWillDeleteFiles(updateLastActivitiy),
		vscode.workspace.onDidDeleteFiles(updateLastActivitiy),
		vscode.workspace.onWillRenameFiles(updateLastActivitiy),
		vscode.workspace.onDidRenameFiles(updateLastActivitiy),
		vscode.workspace.onDidChangeConfiguration(updateLastActivitiy),
		vscode.languages.registerHoverProvider('*', {
			provideHover: () => {
				updateLastActivitiy();
				return null;
			}
		})
	);

	return vscode.Disposable.from(...disposables);
}
