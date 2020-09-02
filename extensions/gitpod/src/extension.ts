/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createGitpodExtensionContext, GitpodExtensionContext, registerDefaultLayout, registerNotifications, registerWorkspaceCommands, registerWorkspaceSharing, registerWorkspaceTimeout } from './features';
import { GitpodExtension } from './gitpod';
import { v4 } from 'uuid';
import { performance } from 'perf_hooks';

let gitpodContext: GitpodExtensionContext | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<GitpodExtension | undefined> {
	if (typeof vscode.env.remoteName === 'undefined' || context.extension.extensionKind !== vscode.ExtensionKind.Workspace) {
		return undefined;
	}

	gitpodContext = await createGitpodExtensionContext(context);
	if (!gitpodContext) {
		return undefined;
	}
	registerUsageAnalytics(gitpodContext);
	registerWorkspaceCommands(gitpodContext);
	registerWorkspaceSharing(gitpodContext);
	registerWorkspaceTimeout(gitpodContext);
	registerNotifications(gitpodContext);
	registerDefaultLayout(gitpodContext);

	await gitpodContext.active;
	return {
		newContext: childContext => gitpodContext!.fork(childContext)
	};
}

export function deactivate() {
	if (!gitpodContext) {
		return;
	}
	return gitpodContext.dispose();
}

function registerUsageAnalytics(context: GitpodExtensionContext): void {
	if (context.devMode && vscode.env.uiKind === vscode.UIKind.Web) {
		return;
	}
	const sessionId = v4();
	const properties = {
		id: sessionId,
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

