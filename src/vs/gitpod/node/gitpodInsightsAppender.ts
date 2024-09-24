/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { ITelemetryAppender, validateTelemetryData } from '../../platform/telemetry/common/telemetryUtils.js';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb.js';
import { WorkspaceInfoResponse, default as supervisor } from '@gitpod/supervisor-api-grpc/lib/info_pb.js';
import * as grpc from '@grpc/grpc-js';
import * as util from 'util';
import { filter } from '../../base/common/objects.js';
import { mapMetrics, mapTelemetryData } from '../../gitpod/common/insightsHelper.js';
import { default as idemetrics } from '@gitpod/ide-metrics-api-grpcweb/lib/index.js';
import { MetricsServiceClient } from '@gitpod/ide-metrics-api-grpcweb/lib/idemetrics_pb_service.js';
import { IGitpodPreviewConfiguration } from '../../base/common/product.js';
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import { ErrorEvent } from '../../platform/telemetry/common/errorTelemetry.js';
import { Analytics, AnalyticsSettings } from '@segment/analytics-node';

const DebugWorkspaceType = supervisor.DebugWorkspaceType;
const WorkspaceInfoRequest = supervisor.WorkspaceInfoRequest;
// const MetricsServiceClient = idemetrics.MetricsServiceClient;
const ReportErrorRequest = idemetrics.ReportErrorRequest;
const sendMetrics = idemetrics.sendMetrics;

class SupervisorConnection {
	readonly deadlines = {
		long: 30 * 1000,
		normal: 15 * 1000,
		short: 5 * 1000
	};
	private readonly addr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
	readonly metadata = new grpc.Metadata();
	readonly info: InfoServiceClient;

	constructor() {
		this.info = new InfoServiceClient(this.addr, grpc.credentials.createInsecure());
	}
}

export class GitpodInsightsAppender implements ITelemetryAppender {

	private _asyncAIClient: Promise<Analytics> | null;
	private readonly _baseProperties: Record<string, any>;
	private readonly supervisor = new SupervisorConnection();
	private galleryHost: string | undefined;

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
	}

	private _withAIClient(callback: (aiClient: Analytics) => void): void {
		if (!this._asyncAIClient) {
			this._asyncAIClient = this.getWorkspaceInfo().then(({ gitpodHost }) => {
				const settings: AnalyticsSettings = {
					writeKey: this.segmentKey,
					// in dev mode we report directly to IDE playground source
					host: 'https://api.segment.io',
					path: '/v1/batch'
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

	log(eventName: string, data?: any): void {
		this.sendAnalytics(eventName, data);
		this.sendMetrics(eventName, data);
		if (eventName === 'UnhandledError') {
			this.sendErrorReport(data as ErrorEvent);
		}
	}

	private async sendAnalytics(eventName: string, data: any): Promise<void> {
		try {
			const mappedEvent = await this.mapAnalytics(eventName, data);
			if (!mappedEvent) {
				return;
			}
			if (process.env['VSCODE_DEV'] && this.gitpodPreview?.log?.analytics) {
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
		const mappedEvent = mapTelemetryData('remote-server', eventName, { ...data.properties, ...data.measurements });
		if (!mappedEvent) {
			return undefined;
		}
		const { workspaceId, instanceId, ownerId, isDebugWorkspace } = await this.getWorkspaceInfo();
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
			const metrics = mapMetrics('remote-server', eventName, data, { galleryHost: this.galleryHost });
			if (!metrics || !metrics.length) {
				return;
			}
			if (process.env['VSCODE_DEV'] && this.gitpodPreview?.log?.metrics) {
				console.log('Gitpod Metrics: ', JSON.stringify(metrics, undefined, 2));
			}
			const client = await this.getMetricsClient();
			if (client) {
				await sendMetrics(client, metrics);
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

	private async sendErrorReport(error: ErrorEvent): Promise<void> {
		const { workspaceId, instanceId, ownerId, isDebugWorkspace } = await this.getWorkspaceInfo();
		const req = new ReportErrorRequest();
		req.setWorkspaceId(workspaceId);
		req.setInstanceId(instanceId);
		req.setUserId(ownerId);
		req.setErrorStack(error.callstack);
		req.setComponent('vscode-server');
		req.setVersion(this.productVersion);
		req.getPropertiesMap().set('error_name', error.uncaught_error_name || '');
		req.getPropertiesMap().set('error_message', error.msg || '');
		req.getPropertiesMap().set('appName', this._baseProperties.appName);
		req.getPropertiesMap().set('uiKind', this._baseProperties.uiKind);
		req.getPropertiesMap().set('debug_workspace', isDebugWorkspace);

		if (process.env['VSCODE_DEV'] && this.gitpodPreview?.log?.errorReports) {
			console.log('Gitpod Error Reports: ', JSON.stringify(req.toObject(), null, 2));
		}
		const client = await this.getMetricsClient();
		if (client) {
			client.reportError(req, (e) => {
				if (e) {
					console.error('failed to send IDE error report:', e);
				}
			});
		}
	}

	private _metricsClient: Promise<MetricsServiceClient | undefined> | undefined;
	private async getMetricsClient() {
		if (!this._metricsClient) {
			this._metricsClient = (async () => {
				let gitpodHost: string | undefined;
				if (process.env['VSCODE_DEV']) {
					gitpodHost = this.gitpodPreview?.host;
				} else {
					const info = await this.getWorkspaceInfo();
					gitpodHost = new URL(info.gitpodHost).host;
				}
				if (!gitpodHost) {
					return undefined;
				}
				const ideMetricsEndpoint = 'https://ide.' + gitpodHost + '/metrics-api';
				return new MetricsServiceClient(ideMetricsEndpoint, { transport: NodeHttpTransport() });
			})();
		}

		return this._metricsClient;
	}

	private _workspaceInfo: Promise<WorkspaceInfoResponse.AsObject & { isDebugWorkspace: 'true' | 'false' | string }> | undefined;
	private async getWorkspaceInfo() {
		if (!this._workspaceInfo) {
			this._workspaceInfo = (async () => {
				const info = (await util.promisify(this.supervisor.info.workspaceInfo.bind(this.supervisor.info, new WorkspaceInfoRequest(), this.supervisor.metadata, {
					deadline: Date.now() + this.supervisor.deadlines.long
				}))()).toObject();
				return {
					...info,
					isDebugWorkspace: String(info.debugWorkspaceType !== DebugWorkspaceType.NODEBUG),
				};
			})();
		}

		return this._workspaceInfo;
	}
}
