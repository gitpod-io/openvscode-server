/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createGitpodExtensionContext, GitpodExtensionContext, registerDefaultLayout, registerNotifications, registerWorkspaceCommands, registerWorkspaceSharing, registerWorkspaceTimeout } from './features';
import { performance } from 'perf_hooks';

export { GitpodExtensionContext, SupervisorConnection, registerTasks } from './features';
export * from './gitpod-plugin-model';

export async function setupGitpodContext(context: vscode.ExtensionContext): Promise<GitpodExtensionContext | undefined> {
	if (typeof vscode.env.remoteName === 'undefined' || context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
		return undefined;
	}

	const gitpodContext = await createGitpodExtensionContext(context);
	if (!gitpodContext) {
		vscode.commands.executeCommand('setContext', 'gitpod.inWorkspace', false);
		return undefined;
	}
	vscode.commands.executeCommand('setContext', 'gitpod.inWorkspace', true);

	vscode.commands.executeCommand('setContext', 'gitpod.ideAlias', gitpodContext.info.getIdeAlias());
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		vscode.commands.executeCommand('setContext', 'gitpod.UIKind', 'web');
	} else if (vscode.env.uiKind === vscode.UIKind.Desktop) {
		vscode.commands.executeCommand('setContext', 'gitpod.UIKind', 'desktop');
	}

	registerUsageAnalytics(gitpodContext);
	registerWorkspaceCommands(gitpodContext);
	registerWorkspaceSharing(gitpodContext);
	registerWorkspaceTimeout(gitpodContext);
	registerNotifications(gitpodContext);
	registerDefaultLayout(gitpodContext);
	return gitpodContext;
}

function registerUsageAnalytics(context: GitpodExtensionContext): void {
	if (context.devMode && vscode.env.uiKind === vscode.UIKind.Web) {
		return;
	}
	const properties = {
		id: vscode.env.sessionId,
		workspaceId: context.info.getWorkspaceId(),
		appName: vscode.env.appName,
		uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
		devMode: context.devMode,
	};
	function fireEvent(phase: 'start' | 'running' | 'end'): Promise<void> {
		return context.gitpod.server.trackEvent({
			event: 'vscode_session',
			properties: {
				...properties,
				timestamp: performance.now(),
				focused: vscode.window.state.focused,
				phase,
			}
		});
	}
	fireEvent('start');
	context.subscriptions.push(vscode.window.onDidChangeWindowState(() => fireEvent('running')));
	context.pendingWillCloseSocket.push(() => fireEvent('end'));
}

