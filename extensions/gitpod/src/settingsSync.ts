/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import TelemetryReporter from './telemetryReporter';

interface ConfigurationSyncStore {
	url: string;
	insidersUrl: string;
	stableUrl: string;
	canSwitch: boolean;
	authenticationProviders: Record<string, { scopes: string[] }>;
}

function getGitpodSyncProviderConfig(serviceUrl: string): ConfigurationSyncStore {
	const syncStoreURL = `${new URL(serviceUrl).toString().replace(/\/$/, '')}/code-sync`;
	return {
		url: syncStoreURL,
		stableUrl: syncStoreURL,
		insidersUrl: syncStoreURL,
		canSwitch: false,
		authenticationProviders: {
			gitpod: {
				scopes: [
					'function:accessCodeSyncStorage',
					'function:getLoggedInUser',
					'function:getGitpodTokenScopes',
					'resource:default'
				]
			}
		}
	};
}

/**
 * Updates the VS Code context to reflect whether the user added Gitpod as their Settings Sync provider.
 */
export async function updateSyncContext(): Promise<boolean> {
	const config = vscode.workspace.getConfiguration();
	const syncProviderConfig = config.get('configurationSync.store');
	const serviceUrl = config.get<string>('gitpod.host')!;
	const gitpodSyncProviderConfig = getGitpodSyncProviderConfig(serviceUrl);
	const addedSyncProvider = !!syncProviderConfig && JSON.stringify(syncProviderConfig) === JSON.stringify(gitpodSyncProviderConfig);
	await vscode.commands.executeCommand('setContext', 'gitpod.addedSyncProvider', addedSyncProvider);
	return addedSyncProvider;
}

/**
 * Adds an authentication provider as a possible provider for code sync.
 * It adds some key configuration to the user settings, so that the user can choose the Gitpod provider when deciding what to use with setting sync.
 * @param enabled - indicates whether to add or remove the configuration
 */
export async function enableSettingsSync(enabled: boolean, telemetry: TelemetryReporter): Promise<void> {
	const promptToCloseAll = async () => {
		const action = 'Close this window';
		const result = await vscode.window.showInformationMessage('Restart VS Code (close all windows) for the new Settings Sync configuration to take effect.', action);
		if (result === action) {
			await vscode.commands.executeCommand('workbench.action.closeWindow');
		}
	};

	let newSyncProviderConfig: ConfigurationSyncStore | undefined;
	let newIgnoredSettingsConfig: string[] | undefined;
	const config = vscode.workspace.getConfiguration();
	const currentSyncProviderConfig: ConfigurationSyncStore | undefined = config.get('configurationSync.store');
	const currentIgnoredSettingsConfig: string[] | undefined = config.get('settingsSync.ignoredSettings');
	const serviceUrl = config.get<string>('gitpod.host')!;
	const gitpodSyncProviderConfig = getGitpodSyncProviderConfig(serviceUrl);
	if (enabled) {
		if (JSON.stringify(currentSyncProviderConfig) === JSON.stringify(gitpodSyncProviderConfig)) {
			return;
		}
		newSyncProviderConfig = gitpodSyncProviderConfig;
		newIgnoredSettingsConfig = currentIgnoredSettingsConfig ?? [];
		if (!newIgnoredSettingsConfig.find(s => s === 'configurationSync.store')) {
			newIgnoredSettingsConfig.push('configurationSync.store');
		}
	} else {
		if (currentSyncProviderConfig === undefined) {
			return;
		}
		newSyncProviderConfig = undefined;
		newIgnoredSettingsConfig = currentIgnoredSettingsConfig?.filter(s => s !== 'configurationSync.store');
	}

	await config.update('settingsSync.ignoredSettings', newIgnoredSettingsConfig, vscode.ConfigurationTarget.Global);
	await config.update('configurationSync.store', newSyncProviderConfig, vscode.ConfigurationTarget.Global);

	telemetry.sendTelemetryEvent('gitpod_desktop_settings_sync', { enabled: String(enabled) });

	await promptToCloseAll();
}
