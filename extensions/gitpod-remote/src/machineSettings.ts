/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseJson, modify as modifyJson, applyEdits as applyEditsJson } from 'jsonc-parser';
import { GitpodExtensionContext } from 'gitpod-shared';
import { PortsStatus } from '@gitpod/supervisor-api-grpc/lib/status_pb';

export async function configureMachineSettings(context: GitpodExtensionContext, supervisorPortList: PortsStatus.AsObject[]) {
	const extRemoteLogsUri: vscode.Uri = context.logUri;
	const remoteUserDataPath = path.posix.dirname(path.posix.dirname(path.posix.dirname(path.posix.dirname(context.logUri.path))));
	const machineSettingsResource = extRemoteLogsUri.with({ path: path.posix.join(remoteUserDataPath, 'Machine', 'settings.json') });
	try {
		let settingsStr: string = '{}';
		const fileExists = await vscode.workspace.fs.stat(machineSettingsResource).then(() => true, () => false);
		if (fileExists) {
			const settingsbuffer = await vscode.workspace.fs.readFile(machineSettingsResource);
			settingsStr = new TextDecoder().decode(settingsbuffer);
		}

		// settings.json is a json with comments file so we use jsonc-parser library
		let modified = false;
		const settingsJson = parseJson(settingsStr);
		if (settingsJson['remote.autoForwardPortsSource'] === undefined) {
			const edits = modifyJson(settingsStr, ['remote.autoForwardPortsSource'], 'process', { formattingOptions: { insertSpaces: true, tabSize: 4, insertFinalNewline: true } });
			settingsStr = applyEditsJson(settingsStr, edits);
			modified = true;
		}
		if (settingsJson['remote.portsAttributes'] === undefined && supervisorPortList.length) {
			const mapOnOpen = (onOpen?: PortsStatus.OnOpenAction) => {
				switch (onOpen) {
					case PortsStatus.OnOpenAction.OPEN_BROWSER:
						return 'openBrowser';
					case PortsStatus.OnOpenAction.OPEN_PREVIEW:
						return 'openPreview';
					case PortsStatus.OnOpenAction.IGNORE:
						return 'silent';
					case PortsStatus.OnOpenAction.NOTIFY:
					case PortsStatus.OnOpenAction.NOTIFY_PRIVATE:
						return 'notify';
					default:
						return 'notify';
				}
			};

			const portsAttributes: any = {};
			for (const port of supervisorPortList) {
				const onAutoForward = mapOnOpen(port.onOpen);
				if (onAutoForward !== 'notify') {
					portsAttributes[port.localPort] = {
						label: port.name,
						onAutoForward: mapOnOpen(port.onOpen)
					};
				}
			}
			const edits = modifyJson(settingsStr, ['remote.portsAttributes'], portsAttributes, { formattingOptions: { insertSpaces: true, tabSize: 4, insertFinalNewline: true } });
			settingsStr = applyEditsJson(settingsStr, edits);
			modified = true;
		}

		if (modified) {
			const settingsbuffer = new TextEncoder().encode(settingsStr);
			await vscode.workspace.fs.writeFile(machineSettingsResource, settingsbuffer);
		}
	} catch (e) {
		context.logger.error(`Could not update ${machineSettingsResource.toString()} resource`, e);
	}
}
