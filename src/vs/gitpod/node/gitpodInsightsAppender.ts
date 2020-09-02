/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { GitpodClient, GitpodServer, GitpodServiceImpl } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import { onUnexpectedError } from 'vs/base/common/errors';
import { ITelemetryAppender, validateTelemetryData } from 'vs/platform/telemetry/common/telemetryUtils';
import { GetTokenRequest } from '@gitpod/supervisor-api-grpc/lib/token_pb';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import { TokenServiceClient } from '@gitpod/supervisor-api-grpc/lib/token_grpc_pb';
import { WorkspaceInfoRequest, WorkspaceInfoResponse } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import * as ReconnectingWebSocket from 'reconnecting-websocket';
import * as WebSocket from 'ws';
import { ConsoleLogger, listen as doListen } from 'vscode-ws-jsonrpc';
import * as grpc from '@grpc/grpc-js';
import * as util from 'util';
import { filter } from 'vs/base/common/objects';
import { mapMetrics, mapTelemetryData } from 'vs/gitpod/common/insightsHelper';
import { MetricsServiceClient, sendMetrics, ReportErrorRequest } from '@gitpod/ide-metrics-api-grpcweb';
import { IGitpodPreviewConfiguration } from 'vs/base/common/product';
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import type { ErrorEvent } from 'vs/platform/telemetry/common/errorTelemetry';
import { RemoteTrackMessage } from '@gitpod/gitpod-protocol/lib/analytics';

class SupervisorConnection {
	readonly deadlines = {
		long: 30 * 1000,
		normal: 15 * 1000,
		short: 5 * 1000
	};
	private readonly addr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
	readonly metadata = new grpc.Metadata();
	readonly status: StatusServiceClient;
	readonly token: TokenServiceClient;
	readonly info: InfoServiceClient;

	constructor() {
		this.status = new StatusServiceClient(this.addr, grpc.credentials.createInsecure());
		this.token = new TokenServiceClient(this.addr, grpc.credentials.createInsecure());
		this.info = new InfoServiceClient(this.addr, grpc.credentials.createInsecure());
	}
}

type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, 'trackEvent' | 'getLoggedInUser'>;
};

export class GitpodInsightsAppender implements ITelemetryAppender {

	private _asyncAIClient: Promise<GitpodConnection> | null;
	private readonly _baseProperties: { appName: string; uiKind: 'web'; version: string };
	private readonly supervisor = new SupervisorConnection();
	private readonly devMode = this.productName.endsWith(' Dev');
	private galleryHost: string | undefined;

	constructor(
		private productName: string,
		private productVersion: string,
		private readonly gitpodPreview?: IGitpodPreviewConfiguration,
		readonly galleryServiceUrl?: string
	) {
		this._asyncAIClient = null;
		this._baseProperties = {
			appName: productName,
			uiKind: 'web',
			version: productVersion,
		};
		this.galleryHost = galleryServiceUrl ? new URL(galleryServiceUrl).host : undefined;
	}

	private _withAIClient(callback: (aiClient: Pick<GitpodServer, 'trackEvent' | 'getLoggedInUser'>) => void): void {
		if (!this._asyncAIClient) {
			this._asyncAIClient = this.getSupervisorData().then(
				(supervisorData) => {
					return this.getClient(this.productName, this.productVersion, supervisorData.serverToken, supervisorData.gitpodHost, supervisorData.gitpodApiEndpoint);
				}
			);
		}

		this._asyncAIClient.then(
			(aiClient) => {
				callback(aiClient.server);
			},
			(err) => {
				onUnexpectedError(err);
				console.error(err);
			}
		);
	}

	log(eventName: string, data?: any): void {
		this.sendAnalytics(data, eventName);
		this.sendMetrics(data, eventName);
		if (eventName === 'UnhandledError') {
			if (data.fromBrowser) {
				return;
			}
			this.sendErrorReport(data as ErrorEvent);
		}
	}

	private async sendAnalytics(data: any, eventName: string): Promise<void> {
		try {
			if (this.devMode) {
				if (this.gitpodPreview?.log?.analytics) {
					const mappedEvent = await this.mapAnalytics(eventName, data);
					if (mappedEvent) {
						console.log('Gitpod Analytics: ', JSON.stringify(mappedEvent, undefined, 2));
					}
				}
			} else {
				this._withAIClient(async (aiClient) => {
					const mappedEvent = await this.mapAnalytics(eventName, data);
					if (mappedEvent) {
						aiClient.trackEvent(mappedEvent);
					}
				});
			}
		} catch (e) {
			console.error('failed to send IDE analytics:', e);
		}
	}

	private async mapAnalytics(eventName: string, data: any): Promise<RemoteTrackMessage | undefined> {
		data = validateTelemetryData(data);
		const mappedEvent = mapTelemetryData('remote-server', eventName, data.properties);
		if (!mappedEvent) {
			return undefined;
		}
		const { workspaceId, instanceId, debugWorkspace } = await this.getSupervisorData();
		mappedEvent.properties = filter(mappedEvent.properties, (_, v) => v !== undefined && v !== null);
		mappedEvent.properties = {
			...mappedEvent.properties,
			...this._baseProperties,
			workspaceId,
			instanceId,
			debugWorkspace,
			// for backward compatibility with reports, we use instanceId in other places
			workspaceInstanceId: instanceId
		};
		return mappedEvent;
	}

	private async sendMetrics(data: any, eventName: string): Promise<void> {
		try {
			const metrics = mapMetrics('remote-server', eventName, data, { galleryHost: this.galleryHost });
			if (!metrics || !metrics.length) {
				return;
			}
			if (this.devMode && this.gitpodPreview?.log?.metrics) {
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

	private async sendErrorReport(error: ErrorEvent): Promise<void> {
		const { workspaceId, instanceId, userId, debugWorkspace } = await this.getSupervisorData();
		const req = new ReportErrorRequest();
		req.setWorkspaceId(workspaceId);
		req.setInstanceId(instanceId);
		req.setUserId(userId);
		req.setErrorStack(error.callstack);
		req.setComponent('vscode-server');
		req.setVersion(this.productVersion);
		req.getPropertiesMap().set('error_name', error.uncaught_error_name || '');
		req.getPropertiesMap().set('error_message', error.msg || '');
		req.getPropertiesMap().set('appName', this._baseProperties.appName);
		req.getPropertiesMap().set('uiKind', this._baseProperties.uiKind);
		req.getPropertiesMap().set('version', this._baseProperties.version);
		req.getPropertiesMap().set('debug_workspace', String(debugWorkspace));

		if (this.devMode) {
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

	flush(): Promise<any> {
		return Promise.resolve(undefined);
	}

	private _metricsClient: Promise<MetricsServiceClient | undefined> | undefined;
	private getMetricsClient(): Promise<MetricsServiceClient | undefined> {
		if (this._metricsClient) {
			return this._metricsClient;
		}
		return this._metricsClient = (async () => {
			let gitpodHost: string | undefined;
			if (!this.devMode) {
				const info = await this.getWorkspaceInfo();
				gitpodHost = new URL(info.getGitpodHost()).host;
			} else if (this.gitpodPreview) {
				gitpodHost = this.gitpodPreview.host;
			}
			if (!gitpodHost) {
				return undefined;
			}
			const ideMetricsEndpoint = 'https://ide.' + gitpodHost + '/metrics-api';
			return new MetricsServiceClient(ideMetricsEndpoint, {
				transport: NodeHttpTransport(),
			});
		})();
	}

	private _workspaceInfo: Promise<WorkspaceInfoResponse> | undefined;
	private getWorkspaceInfo(): Promise<WorkspaceInfoResponse> {
		if (!this._workspaceInfo) {
			this._workspaceInfo = util.promisify(this.supervisor.info.workspaceInfo.bind(this.supervisor.info, new WorkspaceInfoRequest(), this.supervisor.metadata, {
				deadline: Date.now() + this.supervisor.deadlines.long
			}))();
		}
		return this._workspaceInfo;
	}

	private _supervisorData: ReturnType<GitpodInsightsAppender['doGetSupervisorData']> | undefined;
	private getSupervisorData(): ReturnType<GitpodInsightsAppender['doGetSupervisorData']> {
		if (!this._supervisorData) {
			this._supervisorData = this.doGetSupervisorData();
		}
		return this._supervisorData;
	}
	private async doGetSupervisorData() {
		const workspaceInfo = await this.getWorkspaceInfo();

		const gitpodApi = workspaceInfo.getGitpodApi()!;
		const gitpodApiHost = gitpodApi.getHost();
		const gitpodApiEndpoint = gitpodApi.getEndpoint();
		const gitpodHost = workspaceInfo.getGitpodHost();
		const userId = workspaceInfo.getOwnerId();
		const workspaceId = workspaceInfo.getWorkspaceId();
		const instanceId = workspaceInfo.getInstanceId();
		const debugWorkspace = typeof workspaceInfo['getDebugWorkspaceType'] === 'function' ? workspaceInfo.getDebugWorkspaceType() > 0 : false;

		const getTokenRequest = new GetTokenRequest();
		getTokenRequest.setKind('gitpod');
		getTokenRequest.setHost(gitpodApiHost);
		getTokenRequest.addScope('function:trackEvent');
		getTokenRequest.addScope('function:getLoggedInUser');


		const supervisor = this.supervisor;
		const getTokenResponse = await util.promisify(supervisor.token.getToken.bind(supervisor.token, getTokenRequest, supervisor.metadata, {
			deadline: Date.now() + supervisor.deadlines.long
		}))();
		const serverToken = getTokenResponse.getToken();

		return {
			serverToken,
			gitpodHost,
			gitpodApiEndpoint,
			userId,
			workspaceId,
			instanceId,
			debugWorkspace
		};
	}

	// TODO(ak) publish to Segment directly to production/staging untrusted instead, use server api only to resolve a user
	private async getClient(productName: string, productVersion: string, serverToken: string, gitpodHost: string, gitpodApiEndpoint: string): Promise<GitpodConnection> {
		const factory = new JsonRpcProxyFactory<GitpodServer>();
		const gitpodService = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy()) as GitpodConnection;

		const webSocket = new (ReconnectingWebSocket as any)(gitpodApiEndpoint, undefined, {
			maxReconnectionDelay: 10000,
			minReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1.3,
			connectionTimeout: 10000,
			maxRetries: Infinity,
			debug: false,
			startClosed: false,
			WebSocket: class extends WebSocket {
				constructor(address: string, protocols?: string | string[]) {
					super(address, protocols, {
						headers: {
							'Origin': new URL(gitpodHost).origin,
							'Authorization': `Bearer ${serverToken}`,
							'User-Agent': productName,
							'X-Client-Version': productVersion,
						}
					});
				}
			}
		});
		webSocket.onerror = console.error;
		doListen({
			webSocket: webSocket as any,
			onConnection: connection => factory.listen(connection),
			logger: new ConsoleLogger()
		});

		return gitpodService;
	}
}
