/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createGitpodExtensionContext, GitpodExtensionContext, registerDefaultLayout, registerNotifications, registerWorkspaceCommands, registerWorkspaceSharing, registerWorkspaceTimeout } from './features';
import * as uuid from 'uuid';

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

interface TrackVSCodeSession {
	eventName: 'vscode_session',
	optionalProperties: {
		phase: 'start' | 'running' | 'end'
	}
}

interface TrackGitpodOpenLink {
	eventName: 'vscode_execute_command_gitpod_open_link',
	optionalProperties: {
		url: string
	}
}

interface TrackGitpodChangeVSCodeType {
	eventName: 'vscode_execute_command_gitpod_change_vscode_type',
	optionalProperties: {
		type: 'browser' | 'desktop',
		version?: 'insiders'
	}
}

interface TrackGitpodWorkspace {
	eventName: 'vscode_execute_command_gitpod_workspace',
	optionalProperties: {
		action: 'share' | 'stop-sharing' | 'stop' | 'snapshot' | 'extend-timeout'
	}
}

interface TrackGitpodPorts {
	eventName: 'vscode_execute_command_gitpod_ports',
	optionalProperties: {
		action: 'private' | 'public' | 'preview' | 'openBrowser'
	}
}

interface TrackGitpodConfig {
	eventName: 'vscode_execute_command_gitpod_config',
	optionalProperties: {
		action: 'remove' | 'add'
	}
}

type GitpodAnalyticsEvent = TrackVSCodeSession |
	TrackGitpodOpenLink |
	TrackGitpodChangeVSCodeType |
	TrackGitpodWorkspace |
	TrackGitpodPorts |
	TrackGitpodConfig;

export function getAnalyticsEvent(context: GitpodExtensionContext) {
	const sessionId = uuid.v4();
	const defaultProperties = {
		sessionId,
		workspaceId: context.info.getWorkspaceId(),
		instanceId: context.info.getInstanceId(),
		appName: vscode.env.appName,
		uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
		devMode: context.devMode,
		version: vscode.version,
	};
	return function ({ eventName, optionalProperties }: GitpodAnalyticsEvent): Promise<void> {
		const args = {
			event: eventName,
			properties: {
				...optionalProperties,
				...defaultProperties,
				timestamp: Date.now(),
			}
		};
		if (context.devMode && vscode.env.uiKind === vscode.UIKind.Web) {
			context.output.appendLine(`ANALYTICS: ${JSON.stringify(args)} `);
			return Promise.resolve();
		} else {
			return context.gitpod.server.trackEvent(args);
		}

	};
}

function registerUsageAnalytics(context: GitpodExtensionContext): void {
	const fireAnalyticsEvent = getAnalyticsEvent(context);
	fireAnalyticsEvent({
		eventName: 'vscode_session',
		optionalProperties: { phase: 'start' }
	});
	context.subscriptions.push(vscode.window.onDidChangeWindowState(() =>
		fireAnalyticsEvent({
			eventName: 'vscode_session',
			optionalProperties: { phase: 'running' }
		})
	));
	context.pendingWillCloseSocket.push(() =>
		fireAnalyticsEvent({
			eventName: 'vscode_session',
			optionalProperties: { phase: 'end' },
		})
	);
}

