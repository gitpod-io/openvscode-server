/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { IDEMetric } from '@gitpod/ide-metrics-api-grpcweb/lib/index.js';

export interface ReportErrorParam {
	workspaceId: string;
	instanceId: string;
	errorStack: string;
	userId: string;
	component: string;
	version: string;
	properties?: Record<string, string | undefined>;
}

function getEventName(name: string) {
	const str = name.replace('remoteConnection', '').replace('remoteReconnection', '');
	return str.charAt(0).toLowerCase() + str.slice(1);
}

let readAccessTracked = false;
let writeAccessTracked = false;

export function mapMetrics(source: 'window' | 'remote-server', eventName: string, data: any, extraData?: any): IDEMetric[] | undefined {
	const maybeMetrics = doMapMetrics(source, eventName, data, extraData);
	return Array.isArray(maybeMetrics) ? maybeMetrics : typeof maybeMetrics === 'object' ? [maybeMetrics] : undefined;
}

function doMapMetrics(source: 'window' | 'remote-server', eventName: string, data: any, extraData?: any): IDEMetric[] | IDEMetric | undefined {
	if (source === 'remote-server') {
		if (eventName.startsWith('extensionGallery:')) {
			const operation = eventName.split(':')[1];
			if (operation === 'install' || operation === 'update' || operation === 'uninstall') {
				const metrics: IDEMetric[] = [{
					kind: 'counter',
					name: 'gitpod_vscode_extension_gallery_operation_total',
					labels: {
						operation,
						status: data.success ? 'success' : 'failure',
						galleryHost: extraData.galleryHost
						// TODO errorCode
					}
				}];
				if (typeof data.duration === 'number') {
					metrics.push({
						kind: 'histogram',
						name: 'gitpod_vscode_extension_gallery_operation_duration_seconds',
						labels: {
							operation,
							galleryHost: extraData.galleryHost
						},
						value: data.duration / 1000
					});
				}
				return metrics;
			}
		}
		if (eventName === 'galleryService:query') {
			const metrics: IDEMetric[] = [{
				kind: 'counter',
				name: 'gitpod_vscode_extension_gallery_query_total',
				labels: {
					status: data.success ? 'success' : 'failure',
					statusCode: data.statusCode,
					errorCode: data.errorCode,
					galleryHost: extraData.galleryHost
				}
			}, {
				kind: 'histogram',
				name: 'gitpod_vscode_extension_gallery_query_duration_seconds',
				labels: {
					galleryHost: extraData.galleryHost
				},
				value: data.duration / 1000
			}];
			return metrics;
		}
	}
	return undefined;
}

// please don't send same metrics from browser window and remote server
export function mapTelemetryData(source: 'window' | 'remote-server', eventName: string, data: any): { event: string; properties: { [key: string]: any } } | undefined {
	if (eventName.startsWith('extensionGallery:')) {
		const operation = eventName.split(':')[1];
		if (operation === 'install' || operation === 'update' || operation === 'uninstall') {
			return {
				event: 'vscode_extension_gallery',
				properties: {
					kind: operation,
					extensionId: data.id,
					sessionID: data.sessionID,
					timestamp: data.timestamp,
					success: data.success,
					errorCode: data.errorcode,
				},
			};
		}
	}
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
					sessionID: data.sessionID,
					timestamp: data.timestamp
				},
			};
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
				// eslint-disable-next-line local/code-no-dangerous-type-assertions
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
				// eslint-disable-next-line local/code-no-dangerous-type-assertions
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
				// eslint-disable-next-line local/code-no-dangerous-type-assertions
				properties: {
					event: getEventName(eventName),
					reconnectionToken: data.reconnectionToken,
					millisSinceLastIncomingData: data.millisSinceLastIncomingData,
					attempt: data.attempt,
					handled: data.handled,
				} as ReconnectionProperties
			};
	}
	return undefined;
}
