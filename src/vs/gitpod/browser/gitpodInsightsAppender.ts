/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference types='@gitpod/gitpod-protocol/lib/typings/globals'/>

import { IProductService } from 'vs/platform/product/common/productService';
import { ITelemetryAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { mapMetrics, mapTelemetryData, ReportErrorParam } from 'vs/gitpod/common/insightsHelper';
import type { IDEMetric } from '@gitpod/ide-metrics-api-grpcweb';
import type { ErrorEvent } from 'vs/platform/telemetry/common/errorTelemetry';

type SendMetrics = (metrics: IDEMetric[]) => Promise<void>;
type ErrorReports = (errors: ReportErrorParam) => Promise<void>;
interface SupervisorWorkspaceInfo { gitpodHost: string; instanceId: string; workspaceId: string; debugWorkspaceType?: 'noDebug' | 'regular' | 'prebuild'; ownerId: string }

export class GitpodInsightsAppender implements ITelemetryAppender {
	private readonly _baseProperties: { appName: string; uiKind: 'web'; version: string };
	private readonly devMode = this.productService.nameShort.endsWith(' Dev');
	private galleryHost: string | undefined;

	constructor(
		@IProductService private readonly productService: IProductService
	) {
		this._baseProperties = {
			appName: this.productService.nameShort,
			uiKind: 'web',
			version: this.productService.version,
		};
		this.galleryHost = this.productService.extensionsGallery?.serviceUrl ? new URL(this.productService.extensionsGallery?.serviceUrl).host : undefined;
	}

	public log(eventName: string, data: any): void {
		this.sendAnalytics(eventName, data);
		this.sendMetrics(eventName, data);
		if (eventName === 'UnhandledError') {
			this.sendErrorReports(data as ErrorEvent);
		}
	}

	private sendAnalytics(eventName: string, data: any): void {
		try {
			const trackMessage = mapTelemetryData('window', eventName, data);
			if (!trackMessage) {
				return;
			}
			trackMessage.properties = {
				...trackMessage.properties,
				...this._baseProperties,
			};
			if (this.devMode) {
				if (this.productService.gitpodPreview?.log?.analytics) {
					console.log('Gitpod Analytics: ', JSON.stringify(trackMessage, undefined, 2));
				}
			} else {
				// TODO(ak) get rid of it
				// it is bad usage of window.postMessage
				// we should use Segment directly here and publish to production/staging untrusted
				// use server api to resolve a user
				window.postMessage({ type: 'vscode_telemetry', event: trackMessage.event, properties: trackMessage.properties }, '*');
			}
		} catch (e) {
			console.error('failed to send IDE analytic:', e);
		}
	}

	private async sendMetrics(eventName: string, data: any): Promise<void> {
		try {
			const metrics = mapMetrics('window', eventName, data, { galleryHost: this.galleryHost });
			if (!metrics || !metrics.length) {
				return;
			}
			if (this.devMode) {
				if (this.productService.gitpodPreview?.log?.metrics) {
					console.log('Gitpod Metrics: ', JSON.stringify(metrics, undefined, 2));
				}
			}
			const doSendMetrics = await this.getSendMetrics();
			if (doSendMetrics) {
				await doSendMetrics(metrics);
			}
		} catch (e) {
			console.error('failed to send IDE metric:', e);
		}
	}

	private _sendMetrics: Promise<SendMetrics | undefined> | undefined;
	private getSendMetrics(): Promise<SendMetrics | undefined> {
		if (this._sendMetrics) {
			return this._sendMetrics;
		}
		return this._sendMetrics = (async () => {
			const gitpodWsInfo = await this.getGitpodWorkspaceInfo();
			if (!gitpodWsInfo.gitpodHost) {
				return undefined;
			}
			// load grpc-web before see https://github.com/gitpod-io/gitpod/issues/4448
			await import('@improbable-eng/grpc-web');
			const { MetricsServiceClient, sendMetrics } = await import('@gitpod/ide-metrics-api-grpcweb');
			const ideMetricsEndpoint = 'https://ide.' + gitpodWsInfo.gitpodHost + '/metrics-api';
			const client = new MetricsServiceClient(ideMetricsEndpoint);
			return async (metrics: IDEMetric[]) => {
				await sendMetrics(client, metrics);
			};
		})();
	}

	private async sendErrorReports(error: ErrorEvent) {
		const gitpodWsInfo = await this.getGitpodWorkspaceInfo();
		const params: ReportErrorParam = {
			workspaceId: gitpodWsInfo.workspaceId,
			instanceId: gitpodWsInfo.instanceId,
			errorStack: error.callstack,
			userId: window.gitpod.loggedUserID || gitpodWsInfo.ownerId,
			component: 'vscode-web',
			version: this._baseProperties.version,
			properties: {
				error_name: error.uncaught_error_name,
				error_message: error.msg,
				debug_workspace: String(!!gitpodWsInfo.debugWorkspaceType && gitpodWsInfo.debugWorkspaceType !== 'noDebug'),
				...this._baseProperties,
			}
		};
		if (this.devMode && this.productService.gitpodPreview?.log?.errorReports) {
			console.log('Gitpod Error Reports: ', JSON.stringify(params, undefined, 2));
		}
		const doSend = await this.getSendErrorReports();
		if (doSend) {
			await doSend(params);
		}
	}

	private _sendErrorReports: Promise<ErrorReports | undefined> | undefined;
	private getSendErrorReports(): Promise<ErrorReports | undefined> {
		if (this._sendErrorReports) {
			return this._sendErrorReports;
		}
		return this._sendErrorReports = (async () => {
			const gitpodWsInfo = await this.getGitpodWorkspaceInfo();
			if (!gitpodWsInfo.gitpodHost) {
				return undefined;
			}
			const ideMetricsHttpEndpoint = 'https://ide.' + gitpodWsInfo.gitpodHost + '/metrics-api/reportError';
			return async (params: ReportErrorParam) => {
				const response = await fetch(ideMetricsHttpEndpoint, {
					method: 'POST',
					body: JSON.stringify(params),
					credentials: 'omit',
				});
				if (!response.ok) {
					const data = await response.json();
					console.error(`Cannot report error: ${response.status} ${response.statusText}`, data);
				}
			};
		})();
	}

	private _gitpodWsInfo: Promise<SupervisorWorkspaceInfo> | undefined;
	private getGitpodWorkspaceInfo(): Promise<SupervisorWorkspaceInfo> {
		if (this._gitpodWsInfo) {
			return this._gitpodWsInfo;
		}
		return this._gitpodWsInfo = (async () => {
			const infoResponse = await fetch(window.location.protocol + '//' + window.location.host + '/_supervisor/v1/info/workspace', {
				credentials: 'include'
			});
			if (!infoResponse.ok) {
				throw new Error(`Getting workspace info failed: ${infoResponse.statusText}`);
			}
			const info: SupervisorWorkspaceInfo = await infoResponse.json();
			return {
				gitpodHost: this.devMode ? this.productService.gitpodPreview?.host ?? 'gitpod-staging.com' : new URL(info.gitpodHost).host,
				instanceId: info.instanceId,
				workspaceId: info.workspaceId,
				debugWorkspaceType: info.debugWorkspaceType,
				ownerId: info.ownerId
			};
		})();
	}

	public flush(): Promise<any> {
		return Promise.resolve(undefined);
	}
}
