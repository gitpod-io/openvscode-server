/* eslint-disable code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { RemoteTrackMessage } from '@gitpod/gitpod-protocol/lib/analytics';


function getEventName(name: string) {
	const str = name.replace('remoteConnection', '').replace('remoteReconnection', '');
	return str.charAt(0).toLowerCase() + str.slice(1);
}

// const formatEventName = (str: string) => {
// 	return str
// 		.replace(/^[A-Z]/g, letter => letter.toLowerCase())
// 		.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
// 		.replace(/[^\w]/g, '_');
// };

let readAccessTracked = false;
let writeAccessTracked = false;

export enum SenderKind {
	Browser = 1,
	Node = 2
}

// Please don't send same event for both Browser and Node

export function mapTelemetryData(kind: SenderKind, eventName: string, data: any): RemoteTrackMessage | undefined {
	if (kind === SenderKind.Node) {
		switch (eventName) {
			case 'editorOpened':
				if (readAccessTracked || (<string>data.typeId) !== 'workbench.editors.files.fileEditorInput') {
					return undefined;
				}
				readAccessTracked = true;
				return {
					event: 'vscode_file_access',
					properties: {
						kind: 'read',
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'filePUT':
				if (writeAccessTracked) {
					return undefined;
				}
				writeAccessTracked = true;
				return {
					event: 'vscode_file_access',
					properties: {
						kind: 'write',
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'notification:show':
				return {
					event: 'vscode_notification',
					properties: {
						action: 'show',
						notificationId: data.id,
						source: data.source,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'notification:close':
				return {
					event: 'vscode_notification',
					properties: {
						action: 'close',
						notificationId: data.id,
						source: data.source,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'notification:hide':
				return {
					event: 'vscode_notification',
					properties: {
						action: 'hide',
						notificationId: data.id,
						source: data.source,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'notification:actionExecuted':
				return {
					event: 'vscode_notification',
					properties: {
						action: 'actionExecuted',
						notificationId: data.id,
						source: data.source,
						actionLabel: data.actionLabel,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'settingsEditor.settingModified':
				return {
					event: 'vscode_update_configuration',
					properties: {
						key: data.key,
						target: data.target,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'extensionGallery:install':
				return {
					event: 'vscode_extension_gallery',
					properties: {
						kind: 'install',
						extensionId: data.id,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'extensionGallery:update':
				return {
					event: 'vscode_extension_gallery',
					properties: {
						kind: 'update',
						extensionId: data.id,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'extensionGallery:uninstall':
				return {
					event: 'vscode_extension_gallery',
					properties: {
						kind: 'uninstall',
						extensionId: data.id,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'gettingStarted.ActionExecuted':
				return {
					event: 'vscode_getting_started',
					properties: {
						kind: 'action_executed',
						command: data.command,
						argument: data.argument,
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
			case 'editorClosed':
				if ((<string>data.typeId) !== 'workbench.editors.gettingStartedInput') {
					return undefined;
				}
				return {
					event: 'vscode_getting_started',
					properties: {
						kind: 'editor_closed',
						workspaceId: data.workspaceId,
						workspaceInstanceId: data.workspaceInstanceId,
						sessionID: data.sessionID,
						timestamp: data.timestamp
					},
				};
		}
	} else if (kind === SenderKind.Browser) {
		switch (eventName) {
			case 'remoteConnectionSuccess':
			case 'remoteConnectionFailure':
				type ConnectionProperties = {
					state: string;
					// Time, in ms, until connected / connection failure
					connectionTimeMs: number;
					// Detailed error message of failure
					error?: string;
				};
				return {
					event: 'vscode_browser_remote_connection',
					properties: {
						state: getEventName(eventName),
						// Time, in ms, until connected / connection failure
						connectionTimeMs: data.connectionTimeMs,
						// Detailed error message of failure
						error: data.message,
					} as ConnectionProperties
				};
			case 'remoteConnectionLatency':
				type ConnectionLatencyProperties = {
					// Latency to the remote, in milliseconds
					latencyMs?: number;
				};
				return {
					event: 'vscode_browser_remote_connection_latency',
					properties: {
						latencyMs: data.latencyMs
					} as ConnectionLatencyProperties
				};
			case 'remoteConnectionGain':
			case 'remoteConnectionLost':
			case 'remoteReconnectionWait':
			case 'remoteReconnectionReload':
			case 'remoteReconnectionRunning':
			case 'remoteReconnectionPermanentFailure':
				type ReconnectionProperties = {
					event: string;
					reconnectionToken: string;
					millisSinceLastIncomingData?: number;
					attempt?: number;
					handled?: boolean;
				};
				return {
					event: 'vscode_browser_remote_reconnection',
					properties: {
						event: getEventName(eventName),
						reconnectionToken: data.reconnectionToken,
						millisSinceLastIncomingData: data.millisSinceLastIncomingData,
						attempt: data.attempt,
						handled: data.handled,
					} as ReconnectionProperties
				};
		}
	}
	return undefined;
}
