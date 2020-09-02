/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createGitpodExtensionContext, GitpodExtensionContext, registerDefaultLayout, registerNotifications, registerWorkspaceCommands, registerWorkspaceSharing, registerWorkspaceTimeout } from './features';

export { GitpodExtensionContext, registerTasks, SupervisorConnection, registerIpcHookCli } from './features';
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
	context.fireAnalyticsEvent({
		eventName: 'vscode_session',
		properties: { phase: 'start', focused: vscode.window.state.focused }
	});
	context.subscriptions.push(vscode.window.onDidChangeWindowState(() =>
		context.fireAnalyticsEvent({
			eventName: 'vscode_session',
			properties: { phase: 'running', focused: vscode.window.state.focused }
		})
	));
	context.pendingWillCloseSocket.push(() =>
		context.fireAnalyticsEvent({
			eventName: 'vscode_session',
			properties: { phase: 'end', focused: vscode.window.state.focused },
		})
	);
}

