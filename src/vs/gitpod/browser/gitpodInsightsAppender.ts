/* eslint-disable code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IProductService } from 'vs/platform/product/common/productService';
import { ITelemetryAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { mapMetrics, mapTelemetryData } from 'vs/gitpod/common/insightsHelper';
import type { IDEMetric } from '@gitpod/ide-metrics-api-grpcweb';

type SendMetrics = (metrics: IDEMetric[]) => Promise<void>;

export class GitpodInsightsAppender implements ITelemetryAppender {
	private readonly _baseProperties: { appName: string; uiKind: 'web'; version: string };
	private readonly devMode = this.productService.nameShort.endsWith(' Dev');
	constructor(
		@IProductService private readonly productService: IProductService
	) {
		this._baseProperties = {
			appName: this.productService.nameShort,
			uiKind: 'web',
			version: this.productService.version,
		};
	}

	public log(eventName: string, data: any): void {
		this.sendAnalytics(eventName, data);
		this.sendMetrics(eventName, data);
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
			const metrics = mapMetrics('window', eventName, data);
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
			let gitpodHost: string | undefined;
			if (!this.devMode) {
				const infoResponse = await fetch(window.location.protocol + '//' + window.location.host + '/_supervisor/v1/info/workspace', {
					credentials: 'include'
				});
				if (!infoResponse.ok) {
					throw new Error(`Getting workspace info failed: ${infoResponse.statusText}`);
				}
				const info: { gitpodHost: string } = await infoResponse.json();
				gitpodHost = new URL(info.gitpodHost).host;
			} else if (this.productService.gitpodPreview) {
				gitpodHost = this.productService.gitpodPreview.host;
			}
			if (!gitpodHost) {
				return undefined;
			}
			// load grpc-web before see https://github.com/gitpod-io/gitpod/issues/4448
			await import('@improbable-eng/grpc-web');
			const { MetricsServiceClient, sendMetrics } = await import('@gitpod/ide-metrics-api-grpcweb');
			const ideMetricsEndpoint = 'https://ide.' + gitpodHost + '/metrics-api';
			const client = new MetricsServiceClient(ideMetricsEndpoint);
			return async (metrics: IDEMetric[]) => {
				await sendMetrics(client, metrics);
			};
		})();
	}

	public flush(): Promise<any> {
		return Promise.resolve(undefined);
	}
}
