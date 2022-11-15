/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vscode-dts/vscode.d.ts'/>
/// <reference path='../../../src/vscode-dts/vscode.proposed.resolvers.d.ts'/>
/// <reference path='../../../src/vscode-dts/vscode.proposed.tunnels.d.ts'/>

import * as grpc from '@grpc/grpc-js';
import { GitpodExtensionContext, setupGitpodContext, registerTasks, registerIpcHookCli, ExposedServedGitpodWorkspacePort, GitpodWorkspacePort, isExposedServedGitpodWorkspacePort, isGRPCErrorStatus } from 'gitpod-shared';
import { GetTokenRequest } from '@gitpod/supervisor-api-grpc/lib/token_pb';
import { PortsStatus, PortsStatusRequest, PortsStatusResponse, PortVisibility } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { TunnelVisiblity, TunnelPortRequest, RetryAutoExposeRequest, CloseTunnelRequest } from '@gitpod/supervisor-api-grpc/lib/port_pb';
import { ExposePortRequest } from '@gitpod/supervisor-api-grpc/lib/control_pb';
import type * as keytarType from 'keytar';
import fetch from 'node-fetch';
import * as util from 'util';
import * as vscode from 'vscode';
import { ReleaseNotes } from './releaseNotes';
import { registerWelcomeWalkthroughContribution, WELCOME_WALKTROUGH_KEY } from './welcomeWalktrough';
import { ExperimentalSettings } from './experiments';
import { GitpodPortViewProvider } from './portViewProvider';
import { registerExtensionManagement } from './extensionManagment';

let gitpodContext: GitpodExtensionContext | undefined;
export async function activate(context: vscode.ExtensionContext) {
	gitpodContext = await setupGitpodContext(context);
	if (!gitpodContext) {
		return;
	}

	context.globalState.setKeysForSync([WELCOME_WALKTROUGH_KEY, ReleaseNotes.RELEASE_NOTES_LAST_READ_KEY]);

	registerDesktop();
	registerAuth(gitpodContext);
	registerPorts(gitpodContext);
	registerTasks(gitpodContext).then(() => {
		if (vscode.window.terminals.length === 0) {
			// Always show a terminal if no task terminals are created
			vscode.window.createTerminal();
		}
	});

	registerIpcHookCli(gitpodContext);
	registerExtensionManagement(gitpodContext);
	registerWelcomeWalkthroughContribution(gitpodContext);
	context.subscriptions.push(new ReleaseNotes(context));

	await gitpodContext.active;
}

export function deactivate() {
	if (!gitpodContext) {
		return;
	}
	return gitpodContext.dispose();
}

function registerAuth(context: GitpodExtensionContext): void {
	type Keytar = {
		getPassword: typeof keytarType['getPassword'];
		setPassword: typeof keytarType['setPassword'];
		deletePassword: typeof keytarType['deletePassword'];
	};
	interface SessionData {
		id: string;
		account?: {
			label?: string;
			displayName?: string;
			id: string;
		};
		scopes: string[];
		accessToken: string;
	}
	interface UserInfo {
		id: string;
		accountName: string;
	}
	async function resolveAuthenticationSession(data: SessionData, resolveUser: (data: SessionData) => Promise<UserInfo>): Promise<vscode.AuthenticationSession> {
		const needsUserInfo = !data.account;
		const userInfo = needsUserInfo ? await resolveUser(data) : undefined;
		return {
			id: data.id,
			account: {
				label: data.account
					? data.account.label || data.account.displayName!
					: userInfo!.accountName,
				id: data.account?.id ?? userInfo!.id
			},
			scopes: data.scopes,
			accessToken: data.accessToken
		};
	}
	function hasScopes(session: vscode.AuthenticationSession, scopes?: readonly string[]): boolean {
		return !scopes || scopes.every(scope => session.scopes.indexOf(scope) !== -1);
	}
	//#endregion

	//#region gitpod auth
	context.pendingActivate.push((async () => {
		const sessions: vscode.AuthenticationSession[] = [];
		const onDidChangeSessionsEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
		try {
			const resolveGitpodUser = async () => {
				const owser = await context.owner;
				return {
					id: owser.id,
					accountName: owser.name!
				};
			};
			if (vscode.env.uiKind === vscode.UIKind.Web) {
				const keytar: Keytar = require('keytar');
				const value = await keytar.getPassword(`${vscode.env.uriScheme}-gitpod.login`, 'account');
				if (value) {
					await keytar.deletePassword(`${vscode.env.uriScheme}-gitpod.login`, 'account');
					const sessionData: SessionData[] = JSON.parse(value);
					if (sessionData.length) {
						const session = await resolveAuthenticationSession(sessionData[0], resolveGitpodUser);
						sessions.push(session);
					}
				}
			} else {
				const getTokenRequest = new GetTokenRequest();
				getTokenRequest.setKind('gitpod');
				getTokenRequest.setHost(context.info.getGitpodApi()!.getHost());
				const scopes = [
					'function:accessCodeSyncStorage'
				];
				for (const scope of scopes) {
					getTokenRequest.addScope(scope);
				}
				const getTokenResponse = await util.promisify(context.supervisor.token.getToken.bind(context.supervisor.token, getTokenRequest, context.supervisor.metadata, {
					deadline: Date.now() + context.supervisor.deadlines.long
				}))();
				const accessToken = getTokenResponse.getToken();
				const session = await resolveAuthenticationSession({
					// current session ID should remain stable between window reloads
					// otherwise setting sync will log out
					id: 'gitpod-current-session',
					accessToken,
					scopes
				}, resolveGitpodUser);
				sessions.push(session);
				onDidChangeSessionsEmitter.fire({ added: [session], changed: [], removed: [] });
			}
		} catch (e) {
			console.error('Failed to restore Gitpod session:', e);
		}
		context.subscriptions.push(onDidChangeSessionsEmitter);
		context.subscriptions.push(vscode.authentication.registerAuthenticationProvider('gitpod', 'Gitpod', {
			onDidChangeSessions: onDidChangeSessionsEmitter.event,
			getSessions: scopes => {
				if (!scopes) {
					return Promise.resolve(sessions);
				}
				return Promise.resolve(sessions.filter(session => hasScopes(session, scopes)));
			},
			createSession: async () => {
				throw new Error('not supported');
			},
			removeSession: async () => {
				throw new Error('not supported');
			},
		}, { supportsMultipleAccounts: false }));
	})());
	//#endregion gitpod auth

	//#region github auth
	context.pendingActivate.push((async () => {
		const onDidChangeGitHubSessionsEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
		const gitHubSessionID = 'github-session';
		let gitHubSession: vscode.AuthenticationSession | undefined;

		async function resolveGitHubUser(data: SessionData): Promise<UserInfo> {
			const userResponse = await fetch('https://api.github.com/user', {
				headers: {
					Authorization: `token ${data.accessToken}`,
					'User-Agent': 'Gitpod-Code'
				}
			});
			if (!userResponse.ok) {
				throw new Error(`Getting GitHub account info failed: ${userResponse.statusText}`);
			}
			const user = await (userResponse.json() as Promise<{ id: string; login: string }>);
			return {
				id: user.id,
				accountName: user.login
			};
		}

		async function loginGitHub(scopes?: readonly string[]): Promise<vscode.AuthenticationSession> {
			const getTokenRequest = new GetTokenRequest();
			getTokenRequest.setKind('git');
			getTokenRequest.setHost('github.com');
			if (scopes) {
				for (const scope of scopes) {
					getTokenRequest.addScope(scope);
				}
			}
			const getTokenResponse = await util.promisify(context.supervisor.token.getToken.bind(context.supervisor.token, getTokenRequest, context.supervisor.metadata, {
				deadline: Date.now() + context.supervisor.deadlines.long
			}))();
			const accessToken = getTokenResponse.getToken();
			gitHubSession = await resolveAuthenticationSession({
				id: gitHubSessionID,
				accessToken,
				scopes: getTokenResponse.getScopeList()
			}, resolveGitHubUser);
			onDidChangeGitHubSessionsEmitter.fire({ added: [gitHubSession], changed: [], removed: [] });
			return gitHubSession;
		}

		try {
			await loginGitHub();
		} catch (e) {
			console.error('Failed an initial GitHub login:', e);
		}

		context.subscriptions.push(vscode.authentication.registerAuthenticationProvider('github', 'GitHub', {
			onDidChangeSessions: onDidChangeGitHubSessionsEmitter.event,
			getSessions: scopes => {
				const sessions = [];
				if (gitHubSession && hasScopes(gitHubSession, scopes)) {
					sessions.push(gitHubSession);
				}
				return Promise.resolve(sessions);
			},
			createSession: async scopes => {
				try {
					const session = await loginGitHub(scopes);
					return session;
				} catch (e) {
					console.error('GitHub sign in failed: ', e);
					throw e;
				}
			},
			removeSession: async id => {
				if (id === gitHubSession?.id) {
					const session = gitHubSession;
					gitHubSession = undefined;
					onDidChangeGitHubSessionsEmitter.fire({ removed: [session], added: [], changed: [] });
				}
			},
		}, { supportsMultipleAccounts: false }));
	})());
}

interface PortItem { port: GitpodWorkspacePort }

async function registerPorts(context: GitpodExtensionContext): Promise<void> {

	const packageJSON = context.extension.packageJSON;
	const experiments = new ExperimentalSettings('gitpod', packageJSON.version, context.logger, context.info.getGitpodHost());
	context.subscriptions.push(experiments);

	const portMap = new Map<number, GitpodWorkspacePort>();
	const tunnelMap = new Map<number, vscode.TunnelDescription>();

	// register webview
	const portViewProvider = new GitpodPortViewProvider(context);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(GitpodPortViewProvider.viewType, portViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));

	function openExternal(port: GitpodWorkspacePort) {
		return vscode.env.openExternal(vscode.Uri.parse(port.localUrl));
	}

	function observePortsStatus(): vscode.Disposable {
		let run = true;
		let stopUpdates: Function | undefined;
		(async () => {
			while (run) {
				try {
					const req = new PortsStatusRequest();
					req.setObserve(true);
					const evts = context.supervisor.status.portsStatus(req, context.supervisor.metadata);
					stopUpdates = evts.cancel.bind(evts);

					await new Promise((resolve, reject) => {
						evts.on('end', resolve);
						evts.on('error', reject);
						evts.on('data', (update: PortsStatusResponse) => {
							portMap.clear();
							const portList = update.getPortsList().map(p => p.toObject());
							for (const portStatus of portList) {
								portMap.set(portStatus.localPort, new GitpodWorkspacePort(portStatus.localPort, portStatus, tunnelMap.get(portStatus.localPort)));
							}
							portViewProvider.updatePortsStatus(portList);
						});
					});
				} catch (err) {
					if (!isGRPCErrorStatus(err, grpc.status.CANCELLED)) {
						context.logger.error('cannot maintain connection to supervisor', err);
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

	context.subscriptions.push(observePortsStatus());
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.resolveExternalPort', (portNumber: number) => {
		// eslint-disable-next-line no-async-promise-executor
		return new Promise<string>(async (resolve, reject) => {
			try {
				const tryResolve = () => {
					const port = portMap.get(portNumber);
					const exposed = port?.status?.exposed;
					if (exposed) {
						resolve(exposed.url);
						return true;
					}
					return false;
				};
				if (!tryResolve()) {
					const listenerWebview = portViewProvider.onDidChangePorts(element => {
						if (element === portViewProvider.portMap && tryResolve()) {
							listenerWebview?.dispose();
						}
					});
					const request = new ExposePortRequest();
					request.setPort(portNumber);
					await util.promisify(context.supervisor.control.exposePort.bind(context.supervisor.control, request, context.supervisor.metadata, {
						deadline: Date.now() + context.supervisor.deadlines.normal
					}))();
				}
			} catch (e) {
				reject(e);
			}
		});
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.makePrivate', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'private' }
		});
		gitpodContext?.setPortVisibility(port.status.localPort, 'private');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.makePublic', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'public' }
		});
		gitpodContext?.setPortVisibility(port.status.localPort, 'public');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.tunnelNetwork', ({ port }: PortItem) => {
		gitpodContext?.setTunnelVisibility(port.portNumber, port.portNumber, TunnelVisiblity.NETWORK);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.tunnelHost', async ({ port }: PortItem) =>
		gitpodContext?.setTunnelVisibility(port.portNumber, port.portNumber, TunnelVisiblity.HOST)
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.preview', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'preview' }
		});
		return openPreview(port);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.openBrowser', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'openBrowser' }
		});
		return openExternal(port);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.retryAutoExpose', async ({ port }: PortItem) => {
		const request = new RetryAutoExposeRequest();
		request.setPort(port.portNumber);
		await util.promisify(context.supervisor.port.retryAutoExpose.bind(context.supervisor.port, request, context.supervisor.metadata, {
			deadline: Date.now() + context.supervisor.deadlines.normal
		}))();
	}));

	const portsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
	context.subscriptions.push(portsStatusBarItem);
	async function updateStatusBar(): Promise<void> {
		const exposedPorts: number[] = [];

		for (const port of portMap.values()) {
			if (isExposedServedGitpodWorkspacePort(port)) {
				exposedPorts.push(port.status.localPort);
			}
		}

		let text: string;
		let tooltip = 'Click to open "Ports View"';
		if (exposedPorts.length) {
			text = 'Ports:';
			tooltip += '\n\nPorts';
			text += ` ${exposedPorts.join(', ')}`;
			tooltip += `\nPublic: ${exposedPorts.join(', ')}`;
		} else {
			text = '$(circle-slash) No open ports';
		}

		portsStatusBarItem.text = text;
		portsStatusBarItem.tooltip = tooltip;

		portsStatusBarItem.command = 'gitpod.portsView.focus';
		portsStatusBarItem.show();
	}
	updateStatusBar();

	context.subscriptions.push(portViewProvider.onDidChangePorts(() => updateStatusBar()));

	const currentNotifications = new Set<number>();
	async function showOpenServiceNotification(port: GitpodWorkspacePort, offerMakePublic = false): Promise<void> {
		const localPort = port.portNumber;
		if (currentNotifications.has(localPort)) {
			return;
		}

		const makePublic = 'Make Public';
		const openAction = 'Open Preview';
		const openExternalAction = 'Open Browser';
		const actions = offerMakePublic ? [makePublic, openAction, openExternalAction] : [openAction, openExternalAction];

		currentNotifications.add(localPort);
		const result = await vscode.window.showInformationMessage('A service is available on port ' + localPort, ...actions);
		currentNotifications.delete(localPort);

		if (result === makePublic) {
			await gitpodContext?.setPortVisibility(port.status.localPort, 'public');
		} else if (result === openAction) {
			await openPreview(port);
		} else if (result === openExternalAction) {
			await openExternal(port);
		}
	}
	async function openPreview(port: GitpodWorkspacePort): Promise<void> {
		await vscode.commands.executeCommand('simpleBrowser.api.open', port.externalUrl.toString(), {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: true
		});
	}
	const onDidExposeServedPortListener = (port: ExposedServedGitpodWorkspacePort) => {
		if (port.status.onOpen === PortsStatus.OnOpenAction.IGNORE) {
			return;
		}

		if (port.status.onOpen === PortsStatus.OnOpenAction.OPEN_BROWSER) {
			openExternal(port);
			return;
		}

		if (port.status.onOpen === PortsStatus.OnOpenAction.OPEN_PREVIEW) {
			openPreview(port);
			return;
		}

		if (port.status.onOpen === PortsStatus.OnOpenAction.NOTIFY) {
			showOpenServiceNotification(port);
			return;
		}

		if (port.status.onOpen === PortsStatus.OnOpenAction.NOTIFY_PRIVATE) {
			showOpenServiceNotification(port, port.status.exposed.visibility !== PortVisibility.PUBLIC);
			return;
		}
	};
	context.subscriptions.push(portViewProvider.onDidExposeServedPort(onDidExposeServedPortListener));

	let updateTunnelsTokenSource: vscode.CancellationTokenSource | undefined;
	async function updateTunnels(): Promise<void> {
		if (updateTunnelsTokenSource) {
			updateTunnelsTokenSource.cancel();
		}
		updateTunnelsTokenSource = new vscode.CancellationTokenSource();
		const token = updateTunnelsTokenSource.token;
		// not vscode.workspace.tunnels because of https://github.com/microsoft/vscode/issues/124334
		const currentTunnels = (await vscode.commands.executeCommand('gitpod.getTunnels')) as vscode.TunnelDescription[];
		if (token.isCancellationRequested) {
			return;
		}
		tunnelMap.clear();
		currentTunnels.forEach(tunnel => {
			tunnelMap.set(tunnel.remoteAddress.port, tunnel);
		});
		portViewProvider.updateTunnels(tunnelMap);
	}
	updateTunnels();
	context.subscriptions.push(vscode.workspace.onDidChangeTunnels(() => updateTunnels()));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.vscode.workspace.openTunnel', (tunnelOptions: vscode.TunnelOptions) => {
		return vscode.workspace.openTunnel(tunnelOptions);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.api.openTunnel', async (tunnelOptions: vscode.TunnelOptions, _tunnelCreationOptions: vscode.TunnelCreationOptions) => {
		const request = new TunnelPortRequest();
		request.setPort(tunnelOptions.remoteAddress.port);
		request.setTargetPort(tunnelOptions.localAddressPort || tunnelOptions.remoteAddress.port);
		request.setVisibility(tunnelOptions.privacy === 'public' ? TunnelVisiblity.NETWORK : TunnelVisiblity.HOST);
		await util.promisify(context.supervisor.port.tunnel.bind(context.supervisor.port, request, context.supervisor.metadata, {
			deadline: Date.now() + context.supervisor.deadlines.normal
		}))();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.api.closeTunnel', async (port: number) => {
		const request = new CloseTunnelRequest();
		request.setPort(port);
		await util.promisify(context.supervisor.port.closeTunnel.bind(context.supervisor.port, request, context.supervisor.metadata, {
			deadline: Date.now() + context.supervisor.deadlines.normal
		}))();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.dev.enableForwardedPortsView', () =>
		vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true)
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.dev.connectLocalApp', async () => {
		const apiPortInput = await vscode.window.showInputBox({
			title: 'Connect to Local App',
			prompt: 'Enter Local App API port',
			value: '63100',
			validateInput: value => {
				const port = Number(value);
				if (port <= 0) {
					return 'port should be greater than 0';
				}
				if (port >= 65535) {
					return 'port should be less than 65535';
				}
				return undefined;
			}
		});
		if (apiPortInput) {
			const apiPort = Number(apiPortInput);
			vscode.commands.executeCommand('gitpod.api.connectLocalApp', apiPort);
		}
	}));
	vscode.commands.executeCommand('setContext', 'gitpod.portsView.visible', true);
}

async function registerDesktop(): Promise<void> {
	const config = vscode.workspace.getConfiguration('gitpod.openInStable');
	if (config.get<boolean>('neverPrompt') === true) {
		return;
	}
	const openAction = 'Open';
	const neverAgain = 'Don\'t Show Again';
	const action = await vscode.window.showInformationMessage('Do you want to open this workspace in VS Code Desktop?', openAction, neverAgain);
	if (action === openAction) {
		vscode.commands.executeCommand('gitpod.openInStable');
	} else if (action === neverAgain) {
		config.update('neverPrompt', true, true);
	}
}
