/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
/// <reference path='../../../src/vs/vscode.d.ts'/>

// TODO get rid of loading inversify and reflect-metadata
require('reflect-metadata');
import { GitpodClient, GitpodServer, GitpodServiceImpl, WorkspaceInstanceUpdateListener } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import { NavigatorContext, PullRequestContext, User } from '@gitpod/gitpod-protocol/lib/protocol';
import { GitpodHostUrl } from '@gitpod/gitpod-protocol/lib/util/gitpod-host-url';
import { ControlServiceClient } from '@gitpod/supervisor-api-grpc/lib/control_grpc_pb';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import { WorkspaceInfoRequest, WorkspaceInfoResponse } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import { NotificationServiceClient } from '@gitpod/supervisor-api-grpc/lib/notification_grpc_pb';
import { NotifyRequest, NotifyResponse, RespondRequest, SubscribeRequest, SubscribeResponse } from '@gitpod/supervisor-api-grpc/lib/notification_pb';
import { PortServiceClient } from '@gitpod/supervisor-api-grpc/lib/port_grpc_pb';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { ContentStatusRequest } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { TerminalServiceClient } from '@gitpod/supervisor-api-grpc/lib/terminal_grpc_pb';
import { TokenServiceClient } from '@gitpod/supervisor-api-grpc/lib/token_grpc_pb';
import { GetTokenRequest } from '@gitpod/supervisor-api-grpc/lib/token_pb';
import * as grpc from '@grpc/grpc-js';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { URL } from 'url';
import * as util from 'util';
import * as vscode from 'vscode';
import { ConsoleLogger, listen as doListen } from 'vscode-ws-jsonrpc';
import WebSocket = require('ws');

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

type UsedGitpodFunction = ['getWorkspace', 'openPort', 'stopWorkspace', 'setWorkspaceTimeout', 'getWorkspaceTimeout', 'getLoggedInUser', 'takeSnapshot', 'controlAdmission', 'sendHeartBeat', 'trackEvent'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>
};

export class GitpodExtensionContext implements vscode.ExtensionContext {

	readonly pendingActivate: Promise<void>[] = [];
	readonly workspaceContextUrl: vscode.Uri;

	constructor(
		private readonly context: vscode.ExtensionContext,
		readonly devMode: boolean,
		readonly config: typeof import('./gitpod-plugin-model'),
		readonly supervisor: SupervisorConnection,
		readonly gitpod: GitpodConnection,
		private readonly webSocket: Promise<ReconnectingWebSocket> | undefined,
		readonly pendingWillCloseSocket: (() => Promise<void>)[],
		readonly info: WorkspaceInfoResponse,
		readonly owner: Promise<User>,
		readonly user: Promise<User>,
		readonly instanceListener: Promise<WorkspaceInstanceUpdateListener>,
		readonly workspaceOwned: Promise<boolean>,
		readonly output: vscode.OutputChannel,
		readonly ipcHookCli: string | undefined
	) {
		this.workspaceContextUrl = vscode.Uri.parse(info.getWorkspaceContextUrl());
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
				this.output.appendLine('failed to dispose context: ' + e);
				console.error('failed to dispose context:', e);
			}
		})();
	}
}

export async function createGitpodExtensionContext(context: vscode.ExtensionContext): Promise<GitpodExtensionContext | undefined> {
	const output = vscode.window.createOutputChannel('Gitpod Workspace');
	const devMode = context.extensionMode === vscode.ExtensionMode.Development || !!process.env['VSCODE_DEV'];

	const supervisor = new SupervisorConnection(context);

	let contentAvailable = false;
	while (!contentAvailable) {
		try {
			const contentStatusRequest = new ContentStatusRequest();
			contentStatusRequest.setWait(true);
			const result = await util.promisify(supervisor.status.contentStatus.bind(supervisor.status, contentStatusRequest, supervisor.metadata, {
				deadline: Date.now() + supervisor.deadlines.long
			}))();
			contentAvailable = result.getAvailable();
		} catch (e) {
			if (e.code === grpc.status.UNAVAILABLE) {
				output.appendLine('It does not look like we are running in a Gitpod workspace, supervisor is not available.');
				return undefined;
			}
			console.error('cannot maintain connection to supervisor', e);
		}
	}

	const workspaceInfo = await util.promisify(supervisor.info.workspaceInfo.bind(supervisor.info, new WorkspaceInfoRequest(), supervisor.metadata, {
		deadline: Date.now() + supervisor.deadlines.long
	}))();

	const workspaceId = workspaceInfo.getWorkspaceId();
	const gitpodHost = workspaceInfo.getGitpodHost();
	const gitpodApi = workspaceInfo.getGitpodApi()!;

	const factory = new JsonRpcProxyFactory<GitpodServer>();
	const gitpodFunctions: UsedGitpodFunction = ['getWorkspace', 'openPort', 'stopWorkspace', 'setWorkspaceTimeout', 'getWorkspaceTimeout', 'getLoggedInUser', 'takeSnapshot', 'controlAdmission', 'sendHeartBeat', 'trackEvent'];
	const gitpodService: GitpodConnection = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy()) as any;
	const gitpodScopes = new Set<string>([
		'resource:workspace::' + workspaceId + '::get/update',
		'function:accessCodeSyncStorage',
	]);
	for (const gitpodFunction of gitpodFunctions) {
		gitpodScopes.add('function:' + gitpodFunction);
	}
	const pendingServerToken = (async () => {
		const getTokenRequest = new GetTokenRequest();
		getTokenRequest.setKind('gitpod');
		getTokenRequest.setHost(gitpodApi.getHost());
		for (const scope of gitpodScopes) {
			getTokenRequest.addScope(scope);
		}
		const getTokenResponse = await util.promisify(supervisor.token.getToken.bind(supervisor.token, getTokenRequest, supervisor.metadata, {
			deadline: Date.now() + supervisor.deadlines.long
		}))();
		return getTokenResponse.getToken();
	})();
	const pendingWillCloseSocket: (() => Promise<void>)[] = [];
	const pendignWebSocket = (async () => {
		const serverToken = await pendingServerToken;
		class GitpodServerWebSocket extends WebSocket {
			constructor(address: string, protocols?: string | string[]) {
				super(address, protocols, {
					headers: {
						'Origin': new URL(gitpodHost).origin,
						'Authorization': `Bearer ${serverToken}`
					}
				});
			}
		}
		const webSocket = new ReconnectingWebSocket(gitpodApi.getEndpoint(), undefined, {
			maxReconnectionDelay: 10000,
			minReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1.3,
			connectionTimeout: 10000,
			maxRetries: Infinity,
			debug: false,
			startClosed: false,
			WebSocket: GitpodServerWebSocket
		});
		webSocket.onerror = console.error;
		doListen({
			webSocket,
			onConnection: connection => factory.listen(connection),
			logger: new ConsoleLogger()
		});
		return webSocket;
	})();

	const pendingGetOwner = gitpodService.server.getLoggedInUser();
	const pendingGetUser = (async () => {
		if (devMode || vscode.env.uiKind !== vscode.UIKind.Web) {
			return pendingGetOwner;
		}
		return vscode.commands.executeCommand('gitpod.api.getLoggedInUser') as typeof pendingGetOwner;
	})();
	const pendingInstanceListener = gitpodService.listenToInstance(workspaceId);
	const pendingWorkspaceOwned = (async () => {
		const owner = await pendingGetOwner;
		const user = await pendingGetUser;
		const workspaceOwned = owner.id === user.id;
		vscode.commands.executeCommand('setContext', 'gitpod.workspaceOwned', workspaceOwned);
		return workspaceOwned;
	})();

	const ipcHookCli = installCLIProxy(context, output);

	const config = await import('./gitpod-plugin-model');
	return new GitpodExtensionContext(
		context,
		devMode,
		config,
		supervisor,
		gitpodService,
		pendignWebSocket,
		pendingWillCloseSocket,
		workspaceInfo,
		pendingGetOwner,
		pendingGetUser,
		pendingInstanceListener,
		pendingWorkspaceOwned,
		output,
		ipcHookCli
	);
}

export async function registerWorkspaceCommands(context: GitpodExtensionContext): Promise<void> {
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.dashboard', () =>
		vscode.env.openExternal(vscode.Uri.parse(context.info.getGitpodHost()))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.accessControl', () =>
		vscode.env.openExternal(vscode.Uri.parse(new GitpodHostUrl(context.info.getGitpodHost()).asAccessControl().toString()))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.settings', () =>
		vscode.env.openExternal(vscode.Uri.parse(new GitpodHostUrl(context.info.getGitpodHost()).asSettings().toString()))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.context', () =>
		vscode.env.openExternal(context.workspaceContextUrl)
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.documentation', () =>
		vscode.env.openExternal(vscode.Uri.parse('https://www.gitpod.io/docs'))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.twitter', () =>
		vscode.env.openExternal(vscode.Uri.parse('https://twitter.com/gitpod'))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.discord', () =>
		vscode.env.openExternal(vscode.Uri.parse('https://www.gitpod.io/chat'))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.open.discourse', () =>
		vscode.env.openExternal(vscode.Uri.parse('https://community.gitpod.io'))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.reportIssue', () =>
		vscode.env.openExternal(vscode.Uri.parse('https://github.com/gitpod-io/gitpod/issues/new/choose'))
	));

	if (context.info.getIdeAlias() === 'code-latest') {
		if (vscode.env.uiKind === vscode.UIKind.Web) {
			function openDesktop(scheme: 'vscode' | 'vscode-insiders'): void {
				const uri = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.[0]?.uri;
				vscode.env.openExternal(vscode.Uri.from({
					scheme,
					authority: 'gitpod.gitpod-desktop',
					path: uri?.path || context.info.getWorkspaceLocationFile() || context.info.getWorkspaceLocationFolder() || context.info.getCheckoutLocation(),
					query: JSON.stringify({
						instanceId: context.info.getInstanceId(),
						workspaceId: context.info.getWorkspaceId(),
						gitpodHost: context.info.getGitpodHost()
					})
				}));
			}
			context.subscriptions.push(vscode.commands.registerCommand('gitpod.openInStable', () => openDesktop('vscode')));
			context.subscriptions.push(vscode.commands.registerCommand('gitpod.openInInsiders', () => openDesktop('vscode-insiders')));
		}
		if (vscode.env.uiKind === vscode.UIKind.Desktop) {
			context.subscriptions.push(vscode.commands.registerCommand('gitpod.openInBrowser', () =>
				vscode.env.openExternal(vscode.Uri.parse(context.info.getWorkspaceUrl()))
			));
		}
	}

	const communityStatusBarItem = vscode.window.createStatusBarItem('gitpod.community', vscode.StatusBarAlignment.Right, -100);
	communityStatusBarItem.name = 'Chat with us on Discourse';
	context.subscriptions.push(communityStatusBarItem);
	communityStatusBarItem.text = '$(comment-discussion)';
	communityStatusBarItem.tooltip = 'Chat with us on Discourse';
	communityStatusBarItem.command = 'gitpod.open.discourse';
	communityStatusBarItem.show();

	const workspaceOwned = await context.workspaceOwned;
	if (!workspaceOwned) {
		return;
	}
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.stop.ws', () =>
		context.gitpod.server.stopWorkspace(context.info.getWorkspaceId())
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.upgradeSubscription', () =>
		vscode.env.openExternal(vscode.Uri.parse(new GitpodHostUrl(context.info.getGitpodHost()).asUpgradeSubscription().toString()))
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.takeSnapshot', async () => {
		try {
			const snapshotId = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
				title: 'Capturing workspace snapshot'
			}, _ => {
				return context.gitpod.server.takeSnapshot({ workspaceId: context.info.getWorkspaceId() /*, layoutData?*/ });
			});
			const hostname = context.info.getGitpodApi()!.getHost();
			const uri = `https://${hostname}#snapshot/${snapshotId}`;
			const copyAction = await vscode.window.showInformationMessage(`The current state is captured in a snapshot. Using [this link](${uri}) anybody can create their own copy of this workspace.`,
				'Copy URL to Clipboard');
			if (copyAction === 'Copy URL to Clipboard') {
				await vscode.env.clipboard.writeText(uri);
			}
		} catch (err) {
			console.error('cannot capture workspace snapshot', err);
			await vscode.window.showErrorMessage(`Cannot capture workspace snapshot: ${err.toString()}`);
		}
	}));
}

export async function registerWorkspaceSharing(context: GitpodExtensionContext): Promise<void> {
	const owner = await context.owner;
	const workspaceOwned = await context.workspaceOwned;
	const workspaceSharingStatusBarItem = vscode.window.createStatusBarItem('gitpod.workspaceSharing', vscode.StatusBarAlignment.Left);
	workspaceSharingStatusBarItem.name = 'Workspace Sharing';
	context.subscriptions.push(workspaceSharingStatusBarItem);
	function setWorkspaceShared(workspaceShared: boolean): void {
		if (workspaceOwned) {
			vscode.commands.executeCommand('setContext', 'gitpod.workspaceShared', workspaceShared);
			if (workspaceShared) {
				workspaceSharingStatusBarItem.text = '$(broadcast) Shared';
				workspaceSharingStatusBarItem.tooltip = 'Your workspace is currently shared. Anyone with the link can access this workspace.';
				workspaceSharingStatusBarItem.command = 'gitpod.stopSharingWorkspace';
			} else {
				workspaceSharingStatusBarItem.text = '$(live-share) Share';
				workspaceSharingStatusBarItem.tooltip = 'Your workspace is currently not shared. Only you can access it.';
				workspaceSharingStatusBarItem.command = 'gitpod.shareWorkspace';
			}
		} else {
			workspaceSharingStatusBarItem.text = '$(broadcast) Shared by ' + owner.name;
			workspaceSharingStatusBarItem.tooltip = `You are currently accessing the workspace shared by ${owner.name}.`;
		}
		workspaceSharingStatusBarItem.show();
	}
	const listener = await context.instanceListener;
	setWorkspaceShared(listener.info.workspace.shareable || false);
	if (!workspaceOwned) {
		return;
	}
	async function controlAdmission(level: GitpodServer.AdmissionLevel): Promise<void> {
		try {
			if (level === 'everyone') {
				const confirm = await vscode.window.showWarningMessage('Sharing your workspace with others also means sharing your access to your repository. Everyone with access to the workspace you share can commit in your name.', { modal: true }, 'Share');
				if (confirm !== 'Share') {
					return;
				}
			}
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
				title: level === 'everyone' ? 'Sharing workspace...' : 'Stopping workspace sharing...'
			}, _ => {
				return context.gitpod.server.controlAdmission(context.info.getWorkspaceId(), level);
			});
			setWorkspaceShared(level === 'everyone');
			if (level === 'everyone') {
				const uri = context.info.getWorkspaceUrl();
				const copyToClipboard = 'Copy URL to Clipboard';
				const res = await vscode.window.showInformationMessage(`Your workspace is currently shared. Anyone with [the link](${uri}) can access this workspace.`, copyToClipboard);
				if (res === copyToClipboard) {
					await vscode.env.clipboard.writeText(uri);
				}
			} else {
				await vscode.window.showInformationMessage(`Your workspace is currently not shared. Only you can access it.`);
			}
		} catch (err) {
			console.error('cannot controlAdmission', err);
			if (level === 'everyone') {
				await vscode.window.showErrorMessage(`Cannot share workspace: ${err.toString()}`);
			} else {
				await vscode.window.showInformationMessage(`Cannot stop workspace sharing: ${err.toString()}`);
			}
		}
	}
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.shareWorkspace', () => controlAdmission('everyone')));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.stopSharingWorkspace', () => controlAdmission('owner')));
}

export async function registerWorkspaceTimeout(context: GitpodExtensionContext): Promise<void> {
	const workspaceOwned = await context.workspaceOwned;
	if (!workspaceOwned) {
		return;
	}

	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ExtendTimeout', async () => {
		try {
			const result = await context.gitpod.server.setWorkspaceTimeout(context.info.getWorkspaceId(), '180m');
			if (result.resetTimeoutOnWorkspaces?.length > 0) {
				vscode.window.showWarningMessage('Workspace timeout has been extended to three hours. This reset the workspace timeout for other workspaces.');
			} else {
				vscode.window.showInformationMessage('Workspace timeout has been extended to three hours.');
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Cannot extend workspace timeout: ${err.toString()}`);
		}
	}));

	const workspaceTimeout = await context.gitpod.server.getWorkspaceTimeout(context.info.getWorkspaceId());
	if (!workspaceTimeout.canChange) {
		return;
	}

	const listener = await context.instanceListener;
	const extendTimeoutStatusBarItem = vscode.window.createStatusBarItem('gitpod.extendTimeout', vscode.StatusBarAlignment.Right, -100);
	extendTimeoutStatusBarItem.name = 'Click to extend the workspace timeout.';
	context.subscriptions.push(extendTimeoutStatusBarItem);
	extendTimeoutStatusBarItem.text = '$(watch)';
	extendTimeoutStatusBarItem.command = 'gitpod.ExtendTimeout';
	const update = () => {
		const instance = listener.info.latestInstance;
		if (!instance) {
			extendTimeoutStatusBarItem.hide();
			return;
		}
		extendTimeoutStatusBarItem.tooltip = `Workspace Timeout: ${instance.status.timeout}. Click to extend.`;
		extendTimeoutStatusBarItem.color = instance.status.timeout === '180m' ? new vscode.ThemeColor('notificationsWarningIcon.foreground') : undefined;
		extendTimeoutStatusBarItem.show();
	};
	update();
	context.subscriptions.push(listener.onDidChange(update));
}

export function registerNotifications(context: GitpodExtensionContext): void {
	function observeNotifications(): vscode.Disposable {
		let run = true;
		let stopUpdates: Function | undefined;
		(async () => {
			while (run) {
				try {
					const evts = context.supervisor.notification.subscribe(new SubscribeRequest(), context.supervisor.metadata);
					stopUpdates = evts.cancel.bind(evts);

					await new Promise((resolve, reject) => {
						evts.on('end', resolve);
						evts.on('error', reject);
						evts.on('data', async (result: SubscribeResponse) => {
							const request = result.getRequest();
							if (request) {
								const level = request.getLevel();
								const message = request.getMessage();
								const actions = request.getActionsList();
								let choice: string | undefined;
								switch (level) {
									case NotifyRequest.Level.ERROR:
										choice = await vscode.window.showErrorMessage(message, ...actions);
										break;
									case NotifyRequest.Level.WARNING:
										choice = await vscode.window.showWarningMessage(message, ...actions);
										break;
									case NotifyRequest.Level.INFO:
									default:
										choice = await vscode.window.showInformationMessage(message, ...actions);
								}
								const respondRequest = new RespondRequest();
								const notifyResponse = new NotifyResponse();
								notifyResponse.setAction(choice || '');
								respondRequest.setResponse(notifyResponse);
								respondRequest.setRequestid(result.getRequestid());
								context.supervisor.notification.respond(respondRequest, context.supervisor.metadata, {
									deadline: Date.now() + context.supervisor.deadlines.normal
								}, (error, _) => {
									if (error?.code !== grpc.status.DEADLINE_EXCEEDED) {
										reject(error);
									}
								});
							}
						});
					});
				} catch (err) {
					if ('code' in err && err.code === grpc.status.UNIMPLEMENTED) {
						console.warn('supervisor does not implement the notification server');
						run = false;
					} else if (!('code' in err && err.code === grpc.status.CANCELLED)) {
						console.error('cannot maintain connection to supervisor', err);
					}
				} finally {
					stopUpdates = undefined;
				}
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		})();
		return new vscode.Disposable(() => {
			run = false;
			if (stopUpdates) {
				stopUpdates();
			}
		});
	}
	context.subscriptions.push(observeNotifications());
}

export function registerDefaultLayout(context: GitpodExtensionContext): void {
	const layoutInitializedKey = 'gitpod:layoutInitialized';
	const layoutInitialized = Boolean(context.globalState.get(layoutInitializedKey));
	if (!layoutInitialized) {
		context.globalState.update(layoutInitializedKey, true);

		(async () => {
			const listener = await context.instanceListener;
			const workspaceContext = listener.info.workspace.context;

			if (PullRequestContext.is(workspaceContext) && /github\.com/i.test(context.workspaceContextUrl.authority)) {
				vscode.commands.executeCommand('github.api.preloadPullRequest');
			}
			// TODO gitlab/bitbucket/any other git hoisting?

			if (NavigatorContext.is(workspaceContext)) {
				const location = vscode.Uri.file(path.join(context.info.getCheckoutLocation(), workspaceContext.path));
				if (workspaceContext.isFile) {
					vscode.window.showTextDocument(location);
				} else {
					vscode.commands.executeCommand('revealInExplorer', location);
				}
			}
		})();
	}
}

function installCLIProxy(context: vscode.ExtensionContext, output: vscode.OutputChannel): string | undefined {
	const vscodeIpcHookCli = process.env['VSCODE_IPC_HOOK_CLI'];
	if (!vscodeIpcHookCli) {
		return undefined;
	}
	const { dir, base } = path.parse(vscodeIpcHookCli);
	const ipcHookCli = path.join(dir, 'gitpod-' + base);
	const ipcProxy = http.createServer((req, res) => {
		const chunks: string[] = [];
		req.setEncoding('utf8');
		req.on('data', (d: string) => chunks.push(d));
		req.pipe(http.request({
			socketPath: vscodeIpcHookCli,
			method: req.method,
			headers: req.headers
		}, async res2 => {
			if (res2.statusCode === 404) {
				const data: { type: 'preview'; url: string; } | any = JSON.parse(chunks.join(''));
				if (data.type === 'preview') {
					// should be aligned with https://github.com/gitpod-io/vscode/blob/4d36a5dbf36870beda891e5dd94ccf087fdc7eb5/src/vs/workbench/api/node/extHostCLIServer.ts#L207-L207
					try {
						const { url } = data;
						await vscode.commands.executeCommand('simpleBrowser.api.open', url, {
							viewColumn: vscode.ViewColumn.Beside,
							preserveFocus: true
						});
						res.writeHead(200);
						res.end();
					} catch (err) {
						res.writeHead(500);
						console.error(err);
						res.end();
					}
					return;
				}
			}
			res2.pipe(res);
		}));
	});
	context.subscriptions.push(new vscode.Disposable(() => ipcProxy.close()));

	new Promise((_, reject) => {
		ipcProxy.on('error', err => reject(err));
		ipcProxy.listen(ipcHookCli);
		context.subscriptions.push(new vscode.Disposable(() =>
			fs.promises.unlink(ipcHookCli)
		));
	}).catch(e => {
		output.appendLine('failed to start cli proxy: ' + e);
		console.error('failed to start cli proxy:' + e);
	});

	return ipcHookCli;
}
