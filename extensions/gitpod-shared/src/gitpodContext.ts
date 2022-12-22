/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as util from 'util';
import * as grpc from '@grpc/grpc-js';
import { GitpodClient, GitpodServer, GitpodServiceImpl, WorkspaceInstanceUpdateListener } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { PortServiceClient } from '@gitpod/supervisor-api-grpc/lib/port_grpc_pb';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { Team } from '@gitpod/gitpod-protocol/lib/teams-projects-protocol';
import { NotificationServiceClient } from '@gitpod/supervisor-api-grpc/lib/notification_grpc_pb';
import { TerminalServiceClient } from '@gitpod/supervisor-api-grpc/lib/terminal_grpc_pb';
import { TokenServiceClient } from '@gitpod/supervisor-api-grpc/lib/token_grpc_pb';
import { PortVisibility } from '@gitpod/gitpod-protocol/lib/workspace-instance';
import { ControlServiceClient } from '@gitpod/supervisor-api-grpc/lib/control_grpc_pb';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import { BaseGitpodAnalyticsEventPropeties, GitpodAnalyticsEvent } from './analytics';
import * as uuid from 'uuid';
import { RemoteTrackMessage } from '@gitpod/gitpod-protocol/lib/analytics';
import { TunnelPortRequest, TunnelVisiblity } from '@gitpod/supervisor-api-grpc/lib/port_pb';
import { WorkspaceInfoResponse } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import { User } from '@gitpod/gitpod-protocol/lib/protocol';
import ReconnectingWebSocket from 'reconnecting-websocket';
import Log from './common/logger';
import { GitpodYml } from './gitpodYaml';
import * as path from 'path';

export class SupervisorConnection {
	readonly deadlines = {
		long: 30 * 1000,
		normal: 15 * 1000,
		short: 5 * 1000
	};
	private readonly addr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
	private readonly clientOptions: Partial<grpc.ClientOptions>;
	readonly metadata = new grpc.Metadata();
	readonly status: StatusServiceClient;
	readonly control: ControlServiceClient;
	readonly notification: NotificationServiceClient;
	readonly token: TokenServiceClient;
	readonly info: InfoServiceClient;
	readonly port: PortServiceClient;
	readonly terminal: TerminalServiceClient;

	constructor(
		context: vscode.ExtensionContext
	) {
		this.clientOptions = {
			'grpc.primary_user_agent': `${vscode.env.appName}/${vscode.version} ${context.extension.id}/${context.extension.packageJSON.version}`,
		};
		this.status = new StatusServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.control = new ControlServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.notification = new NotificationServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.token = new TokenServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.info = new InfoServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.port = new PortServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.terminal = new TerminalServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
	}
}

type UsedGitpodFunction = ['getWorkspace', 'openPort', 'stopWorkspace', 'setWorkspaceTimeout', 'getWorkspaceTimeout', 'getLoggedInUser', 'takeSnapshot', 'waitForSnapshot', 'controlAdmission', 'sendHeartBeat', 'trackEvent', 'getTeams'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>;
};

export class GitpodExtensionContext implements vscode.ExtensionContext {

	readonly sessionId = uuid.v4();
	readonly pendingActivate: Promise<void>[] = [];
	readonly workspaceContextUrl: vscode.Uri;

	public readonly gitpodYml: GitpodYml;

	constructor(
		private readonly context: vscode.ExtensionContext,
		readonly devMode: boolean,
		readonly supervisor: SupervisorConnection,
		readonly gitpod: GitpodConnection,
		private readonly webSocket: Promise<ReconnectingWebSocket> | undefined,
		readonly pendingWillCloseSocket: (() => Promise<void>)[],
		readonly info: WorkspaceInfoResponse,
		readonly owner: Promise<User>,
		readonly user: Promise<User>,
		readonly userTeams: Promise<Team[]>,
		readonly instanceListener: Promise<WorkspaceInstanceUpdateListener>,
		readonly workspaceOwned: Promise<boolean>,
		readonly logger: Log,
		readonly ipcHookCli: string | undefined
	) {
		this.workspaceContextUrl = vscode.Uri.parse(info.getWorkspaceContextUrl());

		const gitpodFileUri = vscode.Uri.file(path.join(info.getCheckoutLocation(), '.gitpod.yml'));
		this.gitpodYml = new GitpodYml(gitpodFileUri);
		this.context.subscriptions.push(this.gitpodYml);
	}

	get active() {
		Object.freeze(this.pendingActivate);
		return Promise.all(this.pendingActivate.map(p => p.catch(console.error)));
	}

	get subscriptions() {
		return this.context.subscriptions;
	}
	get globalState() {
		return this.context.globalState;
	}
	get workspaceState() {
		return this.context.workspaceState;
	}
	get secrets() {
		return this.context.secrets;
	}
	get extensionUri() {
		return this.context.extensionUri;
	}
	get extensionPath() {
		return this.context.extensionPath;
	}
	get environmentVariableCollection() {
		return this.context.environmentVariableCollection;
	}
	asAbsolutePath(relativePath: string): string {
		return this.context.asAbsolutePath(relativePath);
	}
	get storageUri() {
		return this.context.storageUri;
	}
	get storagePath() {
		return this.context.storagePath;
	}
	get globalStorageUri() {
		return this.context.globalStorageUri;
	}
	get globalStoragePath() {
		return this.context.globalStoragePath;
	}
	get logUri() {
		return this.context.logUri;
	}
	get logPath() {
		return this.context.logPath;
	}
	get extensionMode() {
		return this.context.extensionMode;
	}
	get extension() {
		return this.context.extension;
	}
	get extensionRuntime() {
		return (this.context as any).extensionRuntime;
	}

	dispose() {
		const pendingWebSocket = this.webSocket;
		if (!pendingWebSocket) {
			return;
		}
		return (async () => {
			try {
				const webSocket = await pendingWebSocket;
				await Promise.allSettled(this.pendingWillCloseSocket.map(f => f()));
				webSocket.close();
			} catch (e) {
				this.logger.error('failed to dispose context:', e);
				console.error('failed to dispose context:', e);
			}
		})();
	}

	async fireAnalyticsEvent({ eventName, properties }: GitpodAnalyticsEvent): Promise<void> {
		const baseProperties: BaseGitpodAnalyticsEventPropeties = {
			sessionId: this.sessionId,
			workspaceId: this.info.getWorkspaceId(),
			instanceId: this.info.getInstanceId(),
			appName: vscode.env.appName,
			uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
			devMode: this.devMode,
			version: vscode.version,
			timestamp: Date.now(),
			'common.extname': this.extension.id,
			'common.extversion': this.extension.packageJSON.version
		};
		const msg: RemoteTrackMessage = {
			event: eventName,
			properties: {
				...baseProperties,
				...properties,
			}
		};
		if (this.devMode && vscode.env.uiKind === vscode.UIKind.Web) {
			this.logger.trace(`ANALYTICS: ${JSON.stringify(msg)} `);
			return Promise.resolve();
		}
		try {
			await this.gitpod.server.trackEvent(msg);
		} catch (e) {
			this.logger.error('failed to track event:', e);
			console.error('failed to track event:', e);
		}
	}

	async setPortVisibility(port: number, visibility: PortVisibility): Promise<void> {
		await this.gitpod.server.openPort(this.info.getWorkspaceId(), {
			port,
			visibility
		});
	}

	async setTunnelVisibility(port: number, targetPort: number, visibility: TunnelVisiblity): Promise<void> {
		const request = new TunnelPortRequest();
		request.setPort(port);
		request.setTargetPort(targetPort);
		request.setVisibility(visibility);
		await util.promisify(this.supervisor.port.tunnel.bind(this.supervisor.port, request, this.supervisor.metadata, {
			deadline: Date.now() + this.supervisor.deadlines.normal
		}))();
	}
}
