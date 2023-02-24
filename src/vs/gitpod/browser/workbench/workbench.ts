/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference types='@gitpod/gitpod-protocol/lib/typings/globals.d.ts'/>

import type { IDEFrontendState } from '@gitpod/gitpod-protocol/lib/ide-frontend-service.js';
import type { Status, TunnelStatus } from '@gitpod/local-app-api-grpcweb/lib/localapp.d.ts';
import { isStandalone } from '../../../base/browser/browser.js';
import { parse } from '../../../base/common/marshalling.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../base/common/network.js';
import { isEqual } from '../../../base/common/resources.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import product from '../../../platform/product/common/product.js';
import { isFolderToOpen, isWorkspaceToOpen } from '../../../platform/window/common/window.js';
import * as vscode from '../../../workbench/workbench.web.main.internal.js';
import { posix } from '../../../base/common/path.js';
import { ltrim } from '../../../base/common/strings.js';
import type { ISecretStorageProvider } from '../../../platform/secrets/common/secrets.js';
import type { IURLCallbackProvider } from '../../../workbench/services/url/browser/urlService.js';
import type { ICommand, ITunnel, ITunnelProvider, IWorkbenchConstructionOptions, IWorkspace, IWorkspaceProvider } from '../../../workbench/browser/web.api.js';
import type { AuthenticationSessionInfo } from '../../../workbench/services/authentication/browser/authenticationService.js';
import { defaultWebSocketFactory } from '../../../platform/remote/browser/browserSocketFactory.js';
import { RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode } from '../../../platform/remote/common/remoteAuthorityResolver.js';
import { extractLocalHostUriMetaDataForPortMapping, isLocalhost, TunnelPrivacyId } from '../../../platform/tunnel/common/tunnel.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import type { TunnelOptions } from 'vscode';
import { importAMDNodeModule } from '../../../amdX.js';
import { mainWindow } from '../../../base/browser/window.js';

const loadingGrpc = importAMDNodeModule<typeof import('@improbable-eng/grpc-web/dist/typings/index.d.ts')>('@improbable-eng/grpc-web', 'dist/grpc-web-client.umd.js');

export class LocalStorageSecretStorageProvider implements ISecretStorageProvider {
	private readonly _storageKey = 'secrets.provider';

	private _secretsPromise: Promise<Record<string, string>> = this.load();

	type: 'in-memory' | 'persisted' | 'unknown' = 'persisted';

	constructor() { }

	private async load(): Promise<Record<string, string>> {
		const record = this.loadAuthSessionFromElement();
		// Get the secrets from localStorage
		const encrypted = mainWindow.localStorage.getItem(this._storageKey);
		if (encrypted) {
			try {
				const decrypted = JSON.parse(mainWindow.gitpod.decrypt(encrypted));
				return { ...record, ...decrypted };
			} catch (err) {
				console.error('Failed to decrypt secrets from localStorage', err);
				mainWindow.localStorage.removeItem(this._storageKey);
			}
		}

		return record;
	}

	private loadAuthSessionFromElement(): Record<string, string> {
		let authSessionInfo: (AuthenticationSessionInfo & { scopes: string[][] }) | undefined;
		const authSessionElement = mainWindow.document.getElementById('vscode-workbench-auth-session');
		const authSessionElementAttribute = authSessionElement ? authSessionElement.getAttribute('data-settings') : undefined;
		if (authSessionElementAttribute) {
			try {
				authSessionInfo = JSON.parse(authSessionElementAttribute);
			} catch (error) { /* Invalid session is passed. Ignore. */ }
		}

		if (!authSessionInfo) {
			return {};
		}

		const record: Record<string, string> = {};

		// Settings Sync Entry
		record[`${product.urlProtocol}.loginAccount`] = JSON.stringify(authSessionInfo);

		// Auth extension Entry
		if (authSessionInfo.providerId !== 'github') {
			console.error(`Unexpected auth provider: ${authSessionInfo.providerId}. Expected 'github'.`);
			return record;
		}

		const authAccount = JSON.stringify({ extensionId: 'vscode.github-authentication', key: 'github.auth' });
		record[authAccount] = JSON.stringify(authSessionInfo.scopes.map(scopes => ({
			id: authSessionInfo!.id,
			scopes,
			accessToken: authSessionInfo!.accessToken
		})));

		return record;
	}

	async get(key: string): Promise<string | undefined> {
		const secrets = await this._secretsPromise;
		return secrets[key];
	}
	async set(key: string, value: string): Promise<void> {
		const secrets = await this._secretsPromise;
		secrets[key] = value;
		this._secretsPromise = Promise.resolve(secrets);
		this.save();
	}
	async delete(key: string): Promise<void> {
		const secrets = await this._secretsPromise;
		delete secrets[key];
		this._secretsPromise = Promise.resolve(secrets);
		this.save();
	}

	private async save(): Promise<void> {
		try {
			const encrypted = mainWindow.gitpod.encrypt(JSON.stringify(await this._secretsPromise));
			mainWindow.localStorage.setItem(this._storageKey, encrypted);
		} catch (err) {
			console.error(err);
		}
	}
}

class LocalStorageURLCallbackProvider extends Disposable implements IURLCallbackProvider {

	private static REQUEST_ID = 0;

	private static QUERY_KEYS: ('scheme' | 'authority' | 'path' | 'query' | 'fragment')[] = [
		'scheme',
		'authority',
		'path',
		'query',
		'fragment'
	];

	private readonly _onCallback = this._register(new Emitter<URI>());
	readonly onCallback = this._onCallback.event;

	private pendingCallbacks = new Set<number>();
	private lastTimeChecked = Date.now();
	private checkCallbacksTimeout: unknown | undefined = undefined;
	private onDidChangeLocalStorageDisposable: IDisposable | undefined;

	constructor(private readonly _callbackRoute: string) {
		super();
	}

	create(options: Partial<UriComponents> = {}): URI {
		const id = ++LocalStorageURLCallbackProvider.REQUEST_ID;
		const queryParams: string[] = [`vscode-reqid=${id}`];

		for (const key of LocalStorageURLCallbackProvider.QUERY_KEYS) {
			const value = options[key];

			if (value) {
				queryParams.push(`vscode-${key}=${encodeURIComponent(value)}`);
			}
		}

		// TODO@joao remove eventually
		// https://github.com/microsoft/vscode-dev/issues/62
		// https://github.com/microsoft/vscode/blob/159479eb5ae451a66b5dac3c12d564f32f454796/extensions/github-authentication/src/githubServer.ts#L50-L50
		if (!(options.authority === 'vscode.github-authentication' && options.path === '/dummy')) {
			const key = `vscode-web.url-callbacks[${id}]`;
			mainWindow.localStorage.removeItem(key);

			this.pendingCallbacks.add(id);
			this.startListening();
		}

		return URI.parse(mainWindow.location.href).with({ path: this._callbackRoute, query: queryParams.join('&') });
	}

	private startListening(): void {
		if (this.onDidChangeLocalStorageDisposable) {
			return;
		}

		const fn = () => this.onDidChangeLocalStorage();
		mainWindow.addEventListener('storage', fn);
		this.onDidChangeLocalStorageDisposable = { dispose: () => mainWindow.removeEventListener('storage', fn) };
	}

	private stopListening(): void {
		this.onDidChangeLocalStorageDisposable?.dispose();
		this.onDidChangeLocalStorageDisposable = undefined;
	}

	// this fires every time local storage changes, but we
	// don't want to check more often than once a second
	private async onDidChangeLocalStorage(): Promise<void> {
		const ellapsed = Date.now() - this.lastTimeChecked;

		if (ellapsed > 1000) {
			this.checkCallbacks();
		} else if (this.checkCallbacksTimeout === undefined) {
			this.checkCallbacksTimeout = setTimeout(() => {
				this.checkCallbacksTimeout = undefined;
				this.checkCallbacks();
			}, 1000 - ellapsed);
		}
	}

	private checkCallbacks(): void {
		let pendingCallbacks: Set<number> | undefined;

		for (const id of this.pendingCallbacks) {
			const key = `vscode-web.url-callbacks[${id}]`;
			const result = mainWindow.localStorage.getItem(key);

			if (result !== null) {
				try {
					this._onCallback.fire(URI.revive(JSON.parse(result)));
				} catch (error) {
					console.error(error);
				}

				pendingCallbacks = pendingCallbacks ?? new Set(this.pendingCallbacks);
				pendingCallbacks.delete(id);
				mainWindow.localStorage.removeItem(key);
			}
		}

		if (pendingCallbacks) {
			this.pendingCallbacks = pendingCallbacks;

			if (this.pendingCallbacks.size === 0) {
				this.stopListening();
			}
		}

		this.lastTimeChecked = Date.now();
	}
}

class WorkspaceProvider implements IWorkspaceProvider {

	private static QUERY_PARAM_EMPTY_WINDOW = 'ew';
	private static QUERY_PARAM_FOLDER = 'folder';
	private static QUERY_PARAM_WORKSPACE = 'workspace';

	private static QUERY_PARAM_PAYLOAD = 'payload';

	static create(config: IWorkbenchConstructionOptions & { folderUri?: UriComponents; workspaceUri?: UriComponents }) {
		let foundWorkspace = false;
		let workspace: IWorkspace;
		let payload = Object.create(null);

		const query = new URL(document.location.href).searchParams;
		query.forEach((value, key) => {
			switch (key) {

				// Folder
				case WorkspaceProvider.QUERY_PARAM_FOLDER:
					if (config.remoteAuthority && value.startsWith(posix.sep)) {
						// when connected to a remote and having a value
						// that is a path (begins with a `/`), assume this
						// is a vscode-remote resource as simplified URL.
						workspace = { folderUri: URI.from({ scheme: Schemas.vscodeRemote, path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { folderUri: URI.parse(value) };
					}
					foundWorkspace = true;
					break;

				// Workspace
				case WorkspaceProvider.QUERY_PARAM_WORKSPACE:
					if (config.remoteAuthority && value.startsWith(posix.sep)) {
						// when connected to a remote and having a value
						// that is a path (begins with a `/`), assume this
						// is a vscode-remote resource as simplified URL.
						workspace = { workspaceUri: URI.from({ scheme: Schemas.vscodeRemote, path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { workspaceUri: URI.parse(value) };
					}
					foundWorkspace = true;
					break;

				// Empty
				case WorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW:
					workspace = undefined;
					foundWorkspace = true;
					break;

				// Payload
				case WorkspaceProvider.QUERY_PARAM_PAYLOAD:
					try {
						payload = parse(value); // use marshalling#parse() to revive potential URIs
					} catch (error) {
						console.error(error); // possible invalid JSON
					}
					break;
			}
		});

		// If no workspace is provided through the URL, check for config
		// attribute from server and fallback to last opened workspace
		// from storage
		if (!foundWorkspace) {
			if (config.folderUri) {
				workspace = { folderUri: URI.revive(config.folderUri) };
			} else if (config.workspaceUri) {
				workspace = { workspaceUri: URI.revive(config.workspaceUri) };
			}
		}

		return new WorkspaceProvider(workspace, payload, config);
	}

	readonly trusted = true;

	private constructor(
		readonly workspace: IWorkspace,
		readonly payload: object,
		private readonly config: IWorkbenchConstructionOptions
	) {
	}

	async open(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): Promise<boolean> {
		if (options?.reuse && !options.payload && this.isSame(this.workspace, workspace)) {
			return true; // return early if workspace and environment is not changing and we are reusing window
		}

		const targetHref = this.createTargetUrl(workspace, options);
		if (targetHref) {
			if (options?.reuse) {
				mainWindow.location.href = targetHref;
				return true;
			} else {
				let result;
				if (isStandalone()) {
					result = mainWindow.open(targetHref, '_blank', 'toolbar=no'); // ensures to open another 'standalone' window!
				} else {
					result = mainWindow.open(targetHref);
				}

				return !!result;
			}
		}
		return false;
	}

	private createTargetUrl(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): string | undefined {

		// Empty
		let targetHref: string | undefined = undefined;
		if (!workspace) {
			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW}=true`;
		}

		// Folder
		else if (isFolderToOpen(workspace)) {
			let queryParamFolder: string;
			if (this.config.remoteAuthority && workspace.folderUri.scheme === Schemas.vscodeRemote) {
				// when connected to a remote and having a folder
				// for that remote, only use the path as query
				// value to form shorter, nicer URLs.
				// ensure paths are absolute (begin with `/`)
				// clipboard: ltrim(workspace.folderUri.path, posix.sep)
				queryParamFolder = `${posix.sep}${ltrim(workspace.folderUri.path, posix.sep)}`;
			} else {
				queryParamFolder = encodeURIComponent(workspace.folderUri.toString(true));
			}

			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_FOLDER}=${queryParamFolder}`;
		}

		// Workspace
		else if (isWorkspaceToOpen(workspace)) {
			let queryParamWorkspace: string;
			if (this.config.remoteAuthority && workspace.workspaceUri.scheme === Schemas.vscodeRemote) {
				// when connected to a remote and having a workspace
				// for that remote, only use the path as query
				// value to form shorter, nicer URLs.
				// ensure paths are absolute (begin with `/`)
				queryParamWorkspace = `${posix.sep}${ltrim(workspace.workspaceUri.path, posix.sep)}`;
			} else {
				queryParamWorkspace = encodeURIComponent(workspace.workspaceUri.toString(true));
			}

			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_WORKSPACE}=${queryParamWorkspace}`;
		}

		// Append payload if any
		if (options?.payload) {
			targetHref += `&${WorkspaceProvider.QUERY_PARAM_PAYLOAD}=${encodeURIComponent(JSON.stringify(options.payload))}`;
		}

		return targetHref;
	}

	private isSame(workspaceA: IWorkspace, workspaceB: IWorkspace): boolean {
		if (!workspaceA || !workspaceB) {
			return workspaceA === workspaceB; // both empty
		}

		if (isFolderToOpen(workspaceA) && isFolderToOpen(workspaceB)) {
			return isEqual(workspaceA.folderUri, workspaceB.folderUri); // same workspace
		}

		if (isWorkspaceToOpen(workspaceA) && isWorkspaceToOpen(workspaceB)) {
			return isEqual(workspaceA.workspaceUri, workspaceB.workspaceUri); // same workspace
		}

		return false;
	}

	hasRemote(): boolean {
		if (this.workspace) {
			if (isFolderToOpen(this.workspace)) {
				return this.workspace.folderUri.scheme === Schemas.vscodeRemote;
			}

			if (isWorkspaceToOpen(this.workspace)) {
				return this.workspace.workspaceUri.scheme === Schemas.vscodeRemote;
			}
		}

		return true;
	}
}

const devMode = product.nameShort.endsWith(' Dev');

let _state: IDEFrontendState = 'init';
let _failureCause: Error | undefined;
const onDidChangeEmitter = new Emitter<void>();
const toStop = new DisposableStore();
toStop.add(onDidChangeEmitter);
toStop.add({
	dispose: () => {
		_state = 'terminated';
		onDidChangeEmitter.fire();
	}
});

function start(): IDisposable {
	doStart().then(toDoStop => {
		toStop.add(toDoStop);
	}, e => {
		_failureCause = e;
		_state = 'terminated';
		onDidChangeEmitter.fire();
	});
	return toStop;
}

interface WorkspaceInfoResponse {
	workspaceId: string;
	instanceId: string;
	checkoutLocation: string;
	workspaceLocationFile?: string;
	workspaceLocationFolder?: string;
	userHome: string;
	gitpodHost: string;
	gitpodApi: { host: string };
	workspaceContextUrl: string;
	workspaceClusterHost: string;
	ideAlias: string;
}

async function doStart(): Promise<IDisposable> {
	const supervisorHost = mainWindow.location.host;
	const infoResponse = await fetch(mainWindow.location.protocol + '//' + supervisorHost + '/_supervisor/v1/info/workspace', {
		credentials: 'include'
	});
	if (!infoResponse.ok) {
		throw new Error(`Getting workspace info failed: ${infoResponse.statusText}`);
	}
	if (_state === 'terminated') {
		return Disposable.None;
	}

	const subscriptions = new DisposableStore();

	const info: WorkspaceInfoResponse = await infoResponse.json();
	if (_state as any === 'terminated') {
		return Disposable.None;
	}

	const remoteAuthority = mainWindow.location.host;

	// To make webviews work in development, go to file src/vs/workbench/contrib/webview/browser/pre/main.js
	// and update `signalReady` method to bypass hostname check
	const baseUri = FileAccess.asBrowserUri('');
	const basePath = baseUri.path.replace(/\/out\/$/, '');
	let webEndpointUrlTemplate = `${baseUri.scheme}://{{uuid}}.${info.workspaceClusterHost}`;
	if (baseUri.path.startsWith('/blobserve')) {
		webEndpointUrlTemplate += basePath.replace(/^\/blobserve/, '');
	} else {
		webEndpointUrlTemplate += `/${remoteAuthority.split('.', 1)[0]}${basePath}`;
	}
	const webviewEndpoint = webEndpointUrlTemplate + '/out/vs/workbench/contrib/webview/browser/pre/';

	const folderUri = info.workspaceLocationFolder
		? URI.from({
			scheme: Schemas.vscodeRemote,
			authority: remoteAuthority,
			path: info.workspaceLocationFolder
		})
		: undefined;
	const workspaceUri = info.workspaceLocationFile
		? URI.from({
			scheme: Schemas.vscodeRemote,
			authority: remoteAuthority,
			path: info.workspaceLocationFile
		})
		: undefined;

	const gitpodHostURL = new URL(info.gitpodHost);
	const gitpodDomain = gitpodHostURL.protocol + '//*.' + gitpodHostURL.host;

	const secretStorageProvider = new LocalStorageSecretStorageProvider();
	interface GetTokenResponse {
		token: string;
		user?: string;
		scope?: string[];
	}
	const scopes = [
		'function:accessCodeSyncStorage'
	];
	const tokenResponse = await fetch(mainWindow.location.protocol + '//' + supervisorHost + '/_supervisor/v1/token/gitpod/' + info.gitpodApi.host + '/' + scopes.join(','), {
		credentials: 'include'
	});
	if (_state as any === 'terminated') {
		return Disposable.None;
	}
	if (!tokenResponse.ok) {
		console.warn(`Getting Gitpod token failed: ${tokenResponse.statusText}`);
	} else {
		const getToken: GetTokenResponse = await tokenResponse.json();
		if (_state as any === 'terminated') {
			return Disposable.None;
		}

		// see https://github.com/gitpod-io/vscode/blob/gp-code/src/vs/workbench/services/authentication/browser/authenticationService.ts#L34
		type AuthenticationSessionInfo = { readonly id: string; readonly accessToken: string; readonly providerId: string; readonly canSignOut?: boolean };
		const currentSession: AuthenticationSessionInfo = {
			// current session ID should remain stable between window reloads
			// otherwise setting sync will log out
			id: 'gitpod-current-session',
			accessToken: getToken.token,
			providerId: 'gitpod',
			canSignOut: false
		};
		// Settings Sync Entry
		await secretStorageProvider.set(`${product.urlProtocol}.loginAccount`, JSON.stringify(currentSession));
		// Auth extension Entry
		const authAccount = JSON.stringify({ extensionId: 'gitpod.gitpod-web', key: 'gitpod.auth' });
		await secretStorageProvider.set(authAccount, JSON.stringify([{
			id: currentSession.id,
			scopes: getToken.scope || scopes,
			accessToken: currentSession.accessToken
		}]));
	}
	if (_state as any === 'terminated') {
		return Disposable.None;
	}

	const { grpc } = await loadingGrpc;
	const { LocalAppClient, TunnelStatusRequest, TunnelVisiblity } = (await importAMDNodeModule<typeof import('@gitpod/local-app-api-grpcweb')>('@gitpod/local-app-api-grpcweb', 'lib/localapp.js'));

	//#region tunnels
	class Tunnel implements ITunnel {
		localAddress: string;
		remoteAddress: { port: number; host: string };
		privacy?: string;

		private readonly onDidDisposeEmitter = new Emitter<void>();
		readonly onDidDispose = this.onDidDisposeEmitter.event;
		private disposed = false;
		constructor(
			public status: TunnelStatus.AsObject
		) {
			this.remoteAddress = {
				host: 'localhost',
				port: status.remotePort
			};
			this.localAddress = 'http://localhost:' + status.localPort;
			this.privacy = status.visibility === TunnelVisiblity.NETWORK ? TunnelPrivacyId.Public : TunnelPrivacyId.Private;
		}
		async dispose(close = true): Promise<void> {
			if (this.disposed) {
				return;
			}
			this.disposed = true;
			if (close) {
				try {
					await vscode.commands.executeCommand('gitpod.api.closeTunnel', this.remoteAddress.port);
				} catch (e) {
					console.error('failed to close tunnel', e);
				}
			}
			this.onDidDisposeEmitter.fire(undefined);
			this.onDidDisposeEmitter.dispose();
		}
	}
	const tunnels = new Map<number, Tunnel>();
	const onDidChangeTunnels = new Emitter<void>();
	function observeTunneled(apiPort: number): IDisposable {
		const client = new LocalAppClient('http://localhost:' + apiPort, {
			transport: grpc.WebsocketTransport()
		});
		vscode.commands.executeCommand('_setContext', 'gitpod.localAppConnected', true);
		let run = true;
		let stopUpdates: Function | undefined;
		let attempts = 0;
		let reconnectDelay = 1000;
		const maxAttempts = 5;
		(async () => {
			while (run) {
				if (attempts === maxAttempts) {
					vscode.commands.executeCommand('_setContext', 'gitpod.localAppConnected', false);
					console.error(`could not connect to local app ${maxAttempts} times, giving up, use 'Gitpod: Connect to Local App' command to retry`);
					return;
				}
				let err: Error | undefined;
				let status: Status | undefined;
				try {
					const request = new TunnelStatusRequest();
					request.setObserve(true);
					request.setInstanceId(info.instanceId);
					const stream = client.tunnelStatus(request);
					stopUpdates = stream.cancel.bind(stream);
					status = await new Promise<Status | undefined>(resolve => {
						stream.on('end', resolve);
						stream.on('data', response => {
							attempts = 0;
							reconnectDelay = 1000;
							let notify = false;
							const toDispose = new Set(tunnels.keys());
							for (const status of response.getTunnelsList()) {
								toDispose.delete(status.getRemotePort());
								const tunnel = new Tunnel(status.toObject());
								const existing = tunnels.get(status.getRemotePort());
								if (!existing || existing.privacy !== tunnel.privacy) {
									existing?.dispose(false);
									tunnels.set(status.getRemotePort(), tunnel);
									const openTunnelOptions: TunnelOptions = {
										remoteAddress: tunnel.remoteAddress,
										localAddressPort: tunnel.remoteAddress.port,
										privacy: tunnel.privacy
									};
									vscode.commands.executeCommand('gitpod.vscode.workspace.openTunnel', openTunnelOptions);
									notify = true;
								}
							}
							for (const port of toDispose) {
								const tunnel = tunnels.get(port);
								if (tunnel) {
									tunnel.dispose(false);
									tunnels.delete(port);
									notify = true;
								}
							}
							if (notify) {
								onDidChangeTunnels.fire(undefined);
							}
						});
					});
				} catch (e) {
					err = e;
				} finally {
					stopUpdates = undefined;
				}
				if (tunnels.size) {
					for (const tunnel of tunnels.values()) {
						tunnel.dispose(false);
					}
					tunnels.clear();
					onDidChangeTunnels.fire(undefined);
				}
				if (status?.code !== grpc.Code.Canceled) {
					console.warn('cannot maintain connection to local app', err || status);
				}
				await new Promise(resolve => setTimeout(resolve, reconnectDelay));
				reconnectDelay = reconnectDelay * 1.5;
				attempts++;
			}
		})();
		return {
			dispose: () => {
				run = false;
				if (stopUpdates) {
					stopUpdates();
				}
			}
		};
	}
	const defaultApiPort = 63100;
	let cancelObserveTunneled = observeTunneled(defaultApiPort);
	subscriptions.add(cancelObserveTunneled);
	const connectLocalApp: ICommand = {
		id: 'gitpod.api.connectLocalApp',
		handler: (apiPort: number = defaultApiPort) => {
			cancelObserveTunneled.dispose();
			cancelObserveTunneled = observeTunneled(apiPort);
			subscriptions.add(cancelObserveTunneled);
		}
	};
	const getTunnels: ICommand = {
		id: 'gitpod.getTunnels',
		handler: () => /* vscode.TunnelDescription[] */ {
			const result: {
				remoteAddress: { port: number; host: string };
				//The complete local address(ex. localhost:1234)
				localAddress: { port: number; host: string } | string;
				privacy?: string;
			}[] = [];
			for (const tunnel of tunnels.values()) {
				result.push({
					remoteAddress: tunnel.remoteAddress,
					localAddress: tunnel.localAddress,
					privacy: tunnel.privacy
				});
			}
			return result;
		}
	};
	const tunnelProvider: ITunnelProvider = {
		features: {
			privacyOptions: [
				{
					id: 'public',
					label: 'Public',
					themeIcon: 'eye'
				},
				{
					id: 'private',
					label: 'Private',
					themeIcon: 'lock'
				}
			],
			public: true,
			elevation: false,
			protocol: true
		},
		tunnelFactory: async (tunnelOptions, tunnelCreationOptions) => {
			const remotePort = tunnelOptions.remoteAddress.port;
			try {
				if (!isLocalhost(tunnelOptions.remoteAddress.host)) {
					throw new Error('only tunneling of localhost is supported, but: ' + tunnelOptions.remoteAddress.host);
				}
				let tunnel = tunnels.get(remotePort);
				if (!tunnel) {
					await vscode.commands.executeCommand('gitpod.api.openTunnel', tunnelOptions, tunnelCreationOptions);
					tunnel = tunnels.get(remotePort) || await new Promise<Tunnel>(resolve => {
						const toUnsubscribe = onDidChangeTunnels.event(() => {
							const resolved = tunnels.get(remotePort);
							if (resolved) {
								resolve(resolved);
								toUnsubscribe.dispose();
							}
						});
						subscriptions.add(toUnsubscribe);
					});
				}
				return tunnel;
			} catch (e) {
				console.trace(`failed to tunnel to '${tunnelOptions.remoteAddress.host}':'${remotePort}': `, e);
				// actually should be external URL and this method should never throw
				const tunnel = new Tunnel({
					localPort: remotePort,
					remotePort: remotePort,
					visibility: TunnelVisiblity.NONE
				});
				// closed tunnel, invalidate in next tick
				setTimeout(() => tunnel.dispose(false));
				return tunnel;
			}
		}
	};
	//#endregion

	const getLoggedInUser: ICommand = {
		id: 'gitpod.api.getLoggedInUser',
		handler: () => {
			if (devMode) {
				throw new Error('not supported in dev mode');
			}
			return mainWindow.gitpod.loggedUserID;
		}
	};

	const openDesktop: ICommand = {
		id: 'gitpod.api.openDesktop',
		handler: (url: string) => {
			if (!url || url.length === 0) {
				return;
			}
			return mainWindow.gitpod.openDesktopIDE(url);
		}
	};

	vscode.env.getUriScheme().then(() => {
		// Workbench ready
		_state = 'ready';
		onDidChangeEmitter.fire();
	});

	// Use another element other than window.body, workaround for ipad white bar
	// https://github.com/microsoft/vscode/issues/149048
	const workbenchElement = mainWindow.document.getElementById('gp-code-workbench')!;
	subscriptions.add(vscode.create(workbenchElement, {
		// subscriptions.add(vscode.create(document.body, {
		remoteAuthority,
		webviewEndpoint,
		webSocketFactory: {
			create: (url: string, debugLabel: string) => {
				if (_state as any === 'terminated') {
					throw new RemoteAuthorityResolverError('workspace stopped', RemoteAuthorityResolverErrorCode.NotAvailable);
				}
				const socket = defaultWebSocketFactory.create(url, debugLabel);
				const onError = new Emitter<RemoteAuthorityResolverError>();
				socket.onError(e => {
					if (_state as any === 'terminated') {
						// if workspace stopped then don't try to reconnect, regardless how websocket was closed
						e = new RemoteAuthorityResolverError('workspace stopped', RemoteAuthorityResolverErrorCode.NotAvailable, e);
					}
					// otherwise reconnect always
					if (!(e instanceof RemoteAuthorityResolverError)) {
						// by default VS Code does not try to reconnect if the web socket is closed clean:
						// https://github.com/gitpod-io/vscode/blob/7bb129c76b6e95b35758e3e3bc5464ed6ec6397c/src/vs/platform/remote/browser/browserSocketFactory.ts#L150-L152
						// override it as a temporary network error
						e = new RemoteAuthorityResolverError('WebSocket closed', RemoteAuthorityResolverErrorCode.TemporarilyNotAvailable, e);
					}
					onError.fire(e);
				});
				return {
					onData: socket.onData,
					onOpen: socket.onOpen,
					onClose: socket.onClose,
					onError: onError.event,
					send: (data: ArrayBufferView) => socket.send(data),
					close: () => {
						socket.close();
						onError.dispose();
					}
				};
			}
		},
		workspaceProvider: WorkspaceProvider.create({ remoteAuthority, folderUri, workspaceUri }),
		resolveExternalUri: async (uri: URI) => {
			const localhost = extractLocalHostUriMetaDataForPortMapping(uri);
			if (!localhost) {
				return uri;
			}
			let externalEndpoint: URL;
			const tunnel = tunnels.get(localhost.port);
			if (tunnel) {
				externalEndpoint = new URL('http://localhost:' + tunnel.status.localPort);
			} else {
				const publicUrl = (await vscode.commands.executeCommand('gitpod.resolveExternalPort', localhost.port)) as any as string;
				externalEndpoint = new URL(publicUrl);
			}
			externalEndpoint.pathname = uri.path.split('/').map(s => encodeURIComponent(s)).join('/');
			externalEndpoint.hash = encodeURIComponent(uri.fragment);
			// vscode uri is so buggy that if the query part of a url contains percent encoded '=' or '&', it will decode it internally and the url will be invalid forever
			// using /=(.*)/s we can split only on the first ocurrence of '=' if the value also contains a '='
			// sadly not the case if the value contains '&' as it's possible it could signal another query param
			uri.query.split('&').map(s => s.split(/=(.*)/s)).forEach(([k, v]) => !!k && externalEndpoint.searchParams.append(k.replaceAll('+', ' '), v?.replaceAll('+', ' ') || ''));
			return externalEndpoint;
		},
		windowIndicator: {
			onDidChange: Event.None,
			label: `$(gitpod) Gitpod`,
			tooltip: 'Editing on Gitpod'
		},
		initialColorTheme: {
			themeType: ColorScheme.LIGHT,
			// should be aligned with https://github.com/gitpod-io/gitpod-vscode-theme
			colors: {
				'statusBarItem.remoteBackground': '#FF8A00',
				'statusBarItem.remoteForeground': '#f9f9f9',
				'statusBar.background': '#F3F3F3',
				'statusBar.foreground': '#292524',
				'statusBar.noFolderBackground': '#FF8A00',
				'statusBar.debuggingBackground': '#FF8A00',
				'sideBar.background': '#fcfcfc',
				'sideBarSectionHeader.background': '#f9f9f9',
				'activityBar.background': '#f9f9f9',
				'activityBar.foreground': '#292524',
				'editor.background': '#ffffff',
				'button.background': '#FF8A00',
				'button.foreground': '#ffffff',
				'list.activeSelectionBackground': '#e7e5e4',
				'list.activeSelectionForeground': '#292524',
				'list.inactiveSelectionForeground': '#292524',
				'list.inactiveSelectionBackground': '#F9F9F9',
				'minimap.background': '#FCFCFC',
				'minimapSlider.activeBackground': '#F9F9F9',
				'tab.inactiveBackground': '#F9F9F9',
				'editor.selectionBackground': '#FFE4BC',
				'editor.inactiveSelectionBackground': '#FFE4BC',
				'textLink.foreground': '#ffb45b'
			}
		},
		configurationDefaults: {
			'workbench.colorTheme': 'Gitpod Light',
			'workbench.preferredLightColorTheme': 'Gitpod Light',
			'workbench.preferredDarkColorTheme': 'Gitpod Dark',
			'window.commandCenter': false,
			'workbench.layoutControl.enabled': false
		},
		urlCallbackProvider: new LocalStorageURLCallbackProvider('/vscode-extension-auth-callback'),
		secretStorageProvider,
		additionalTrustedDomains: [gitpodDomain],
		productConfiguration: {
			webEndpointUrlTemplate,
		},
		settingsSyncOptions: {
			enabled: true,
			extensionsSyncStateVersion: info.instanceId,
			enablementHandler: (enablement: unknown) => {
				// TODO
			}
		},
		tunnelProvider,
		commands: [
			getTunnels,
			connectLocalApp,
			getLoggedInUser,
			openDesktop,
		]
	}));
	return subscriptions;
}

if (devMode) {
	doStart();
} else {
	mainWindow.gitpod.ideService = {
		get state() {
			return _state;
		},
		get failureCause() {
			return _failureCause;
		},
		onDidChange: onDidChangeEmitter.event,
		start: () => start()
	};
}
