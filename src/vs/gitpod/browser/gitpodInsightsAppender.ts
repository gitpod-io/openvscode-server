/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from 'vs/base/common/errors';
import { ITelemetryAppender, validateTelemetryData } from 'vs/platform/telemetry/common/telemetryUtils';
import { mapMetrics, mapTelemetryData, ReportErrorParam } from 'vs/gitpod/common/insightsHelper';
import type { IDEMetric } from '@gitpod/ide-metrics-api-grpcweb';
import type { ErrorEvent } from 'vs/platform/telemetry/common/errorTelemetry';
import { IGitpodPreviewConfiguration } from 'vs/base/common/product';
import { filter } from 'vs/base/common/objects';
// eslint-disable-next-line local/code-amd-node-module
import { Analytics, AnalyticsSettings } from '@jeanp413/analytics-node-umd';

interface SupervisorWorkspaceInfo { gitpodHost: string; instanceId: string; workspaceId: string; debugWorkspaceType: 'noDebug' | 'regular' | 'prebuild'; ownerId: string }

export class GitpodInsightsAppender implements ITelemetryAppender {

	private _asyncAIClient: Promise<Analytics> | null;
	private readonly _baseProperties: Record<string, any>;
	private galleryHost: string | undefined;

	private readonly devMode: boolean;

	constructor(
		private readonly segmentKey: string,
		productName: string,
		private readonly productVersion: string,
		private readonly gitpodPreview?: IGitpodPreviewConfiguration,
		readonly galleryServiceUrl?: string
	) {
		this._asyncAIClient = null;
		this._baseProperties = {
			appName: productName,
			uiKind: 'web',
			version: productVersion
		};
		this.galleryHost = galleryServiceUrl ? new URL(galleryServiceUrl).host : undefined;

		this.devMode = productName.endsWith(' Dev');
	}

	private _withAIClient(callback: (aiClient: Analytics) => void): void {
		if (!this._asyncAIClient) {
			this._asyncAIClient = this.getWorkspaceInfo().then(({ gitpodHost }) => {
				const settings: AnalyticsSettings = {
					writeKey: this.segmentKey,
					// in dev mode we report directly to IDE playground source
					host: 'https://api.segment.io',
					path: '/v1/batch',
					maxEventsInBatch: 1
				};
				if (this.segmentKey === 'untrusted-dummy-key') {
					settings.host = gitpodHost;
					settings.path = '/analytics/v1/batch';
				}
				return new Analytics(settings);
			});
		}

		this._asyncAIClient.then(
			(aiClient) => {
				callback(aiClient);
			},
			(err) => {
				onUnexpectedError(err);
				console.error(err);
			}
		);
	}

	public log(eventName: string, data: any): void {
		this.sendAnalytics(eventName, data);
		this.sendMetrics(eventName, data);
		if (eventName === 'UnhandledError') {
			this.sendErrorReports(data as ErrorEvent);
		}
	}

	private async sendAnalytics(eventName: string, data: any): Promise<void> {
		try {
			const mappedEvent = await this.mapAnalytics(eventName, data);
			if (!mappedEvent) {
				return;
			}
			if (this.devMode && this.gitpodPreview?.log?.analytics) {
				console.log('Gitpod Analytics: ', JSON.stringify(mappedEvent, undefined, 2));
			}
			this._withAIClient((aiClient) => {
				aiClient.track(mappedEvent);
			});
		} catch (e) {
			console.error('failed to send IDE analytics:', e);
		}
	}

	private async mapAnalytics(eventName: string, data: any) {
		data = validateTelemetryData(data);
		const mappedEvent = mapTelemetryData('window', eventName, { ...data.properties, ...data.measurements });
		if (!mappedEvent) {
			return undefined;
		}
		const { workspaceId, instanceId, isDebugWorkspace, ownerId } = await this.getWorkspaceInfo();
		mappedEvent.properties = filter(mappedEvent.properties, (_, v) => v !== undefined && v !== null);
		mappedEvent.properties = {
			...mappedEvent.properties,
			...this._baseProperties,
			workspaceId,
			instanceId,
			debugWorkspace: isDebugWorkspace,
			// for backward compatibility with reports, we use instanceId in other places
			workspaceInstanceId: instanceId
		};
		return { userId: ownerId, ...mappedEvent };
	}

	private async sendMetrics(eventName: string, data: any): Promise<void> {
		try {
			const metrics = mapMetrics('window', eventName, data, { galleryHost: this.galleryHost });
			if (!metrics || !metrics.length) {
				return;
			}
			if (this.devMode && this.gitpodPreview?.log?.metrics) {
				console.log('Gitpod Metrics: ', JSON.stringify(metrics, undefined, 2));
			}
			const doSendMetrics = await this.getSendMetrics();
			if (doSendMetrics) {
				await doSendMetrics(metrics);
			}
		} catch (e) {
			console.error('failed to send IDE metric:', e);
		}
	}

	flush(): Promise<any> {
		return new Promise(resolve => {
			if (!this._asyncAIClient) {
				return resolve(undefined);
			}
			this._asyncAIClient
				.then(aiClient => aiClient.closeAndFlush({ timeout: 3000 }))
				.finally(() => resolve(undefined));
		});
	}

	private async sendErrorReports(error: ErrorEvent) {
		const gitpodWsInfo = await this.getWorkspaceInfo();
		const params: ReportErrorParam = {
			workspaceId: gitpodWsInfo.workspaceId,
			instanceId: gitpodWsInfo.instanceId,
			userId: window.gitpod.loggedUserID || gitpodWsInfo.ownerId,
			errorStack: error.callstack,
			component: 'vscode-web',
			version: this.productVersion,
			properties: {
				error_name: error.uncaught_error_name,
				error_message: error.msg,
				debug_workspace: gitpodWsInfo.isDebugWorkspace,
				...this._baseProperties,
			}
		};

		if (this.devMode && this.gitpodPreview?.log?.errorReports) {
			console.log('Gitpod Error Reports: ', JSON.stringify(params, undefined, 2));
		}

		const ideMetricsHttpEndpoint = 'https://ide.' + gitpodWsInfo.gitpodHost + '/metrics-api/reportError';
		const response = await fetch(ideMetricsHttpEndpoint, {
			method: 'POST',
			body: JSON.stringify(params),
			credentials: 'omit',
		});
		if (!response.ok) {
			const data = await response.json();
			console.error(`Cannot report error: ${response.status} ${response.statusText}`, data);
		}
	}

	private _sendMetrics: Promise<((metrics: IDEMetric[]) => Promise<void>) | undefined> | undefined;
	private async getSendMetrics() {
		if (!this._sendMetrics) {
			this._sendMetrics = (async () => {
				const gitpodWsInfo = await this.getWorkspaceInfo();
				if (!gitpodWsInfo.gitpodHost) {
					return undefined;
				}
				// load grpc-web before see https://github.com/gitpod-io/gitpod/issues/4448
				await import('@improbable-eng/grpc-web');
				// eslint-disable-next-line local/code-amd-node-module
				const { MetricsServiceClient, sendMetrics } = await import('@gitpod/ide-metrics-api-grpcweb');

				const ideMetricsEndpoint = 'https://ide.' + gitpodWsInfo.gitpodHost + '/metrics-api';
				const client = new MetricsServiceClient(ideMetricsEndpoint);
				return async (metrics: IDEMetric[]) => {
					await sendMetrics(client, metrics);
				};
			})();
		}

		return this._sendMetrics;
	}

	private _workspaceInfo: Promise<SupervisorWorkspaceInfo & { isDebugWorkspace: 'true' | 'false' | string }> | undefined;
	private async getWorkspaceInfo() {
		if (!this._workspaceInfo) {
			this._workspaceInfo = (async () => {
				const infoResponse = await fetch(window.location.protocol + '//' + window.location.host + '/_supervisor/v1/info/workspace', {
					credentials: 'include'
				});
				if (!infoResponse.ok) {
					throw new Error(`Getting workspace info failed: ${infoResponse.statusText}`);
				}
				const info: SupervisorWorkspaceInfo = await infoResponse.json();
				const debugWorkspaceType = info.debugWorkspaceType || 'noDebug';
				return {
					gitpodHost: this.devMode ? this.gitpodPreview?.host ?? 'gitpod-staging.com' : new URL(info.gitpodHost).host,
					instanceId: info.instanceId,
					workspaceId: info.workspaceId,
					debugWorkspaceType,
					ownerId: info.ownerId,
					isDebugWorkspace: String(debugWorkspaceType === 'noDebug'),
				};
			})();
		}

		return this._workspaceInfo;
	}
}
