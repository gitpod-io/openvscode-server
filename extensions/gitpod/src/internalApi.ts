/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { GitpodClient, GitpodServer, GitpodServiceImpl } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import { listen as doListen } from 'vscode-ws-jsonrpc';
import WebSocket from 'ws';
import ReconnectingWebSocket from 'reconnecting-websocket';
import * as vscode from 'vscode';
import Log from './common/logger';

type UsedGitpodFunction = ['getLoggedInUser', 'getGitpodTokenScopes'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>;
};

export const unauthorizedErr = 'unauthorized';

class GitpodServerApi extends vscode.Disposable {

	readonly service: GitpodConnection;
	private readonly webSocket: any;
	private readonly onWillCloseEmitter = new vscode.EventEmitter<number | undefined>();
	readonly onWillClose = this.onWillCloseEmitter.event;

	constructor(accessToken: string, serviceUrl: string, private readonly logger: Log) {
		super(() => this.internalDispose());

		const factory = new JsonRpcProxyFactory<GitpodServer>();
		this.service = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy());

		let retry = 1;
		const maxRetries = 3;
		const webSocket = new ReconnectingWebSocket(`${serviceUrl.replace('https', 'wss')}/api/v1`, undefined, {
			maxReconnectionDelay: 10000,
			minReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1.5,
			connectionTimeout: 10000,
			maxRetries: Infinity,
			debug: false,
			startClosed: false,
			WebSocket: class extends WebSocket {
				constructor(address: string, protocols?: string | string[]) {
					super(address, protocols, {
						headers: {
							'Origin': new URL(serviceUrl).origin,
							'Authorization': `Bearer ${accessToken}`,
							'User-Agent': vscode.env.appName,
							'X-Client-Version': vscode.version
						}
					});
					this.on('unexpected-response', (_, resp) => {
						this.terminate();

						// if mal-formed handshake request (unauthorized, forbidden) or client actions (redirect) are required then fail immediately
						// otherwise try several times and fail, maybe temporarily unavailable, like server restart
						if (retry++ >= maxRetries || (typeof resp.statusCode === 'number' && 300 <= resp.statusCode && resp.statusCode < 500)) {
							webSocket.close(resp.statusCode);
						}
					});
				}
			}
		});
		webSocket.onerror = (e: any) => logger.error('internal server api: failed to open socket', e);

		doListen({
			webSocket,
			logger: this.logger,
			onConnection: connection => factory.listen(connection),
		});
		this.webSocket = webSocket;
	}

	private close(statusCode?: number): void {
		this.onWillCloseEmitter.fire(statusCode);
		try {
			this.webSocket.close();
		} catch (e) {
			this.logger.error('internal server api: failed to close socket', e);
		}
	}

	internalDispose() {
		this.close();
		this.onWillCloseEmitter.dispose();
	}
}

export function withServerApi<T>(accessToken: string, serviceUrl: string, cb: (service: GitpodConnection) => Promise<T>, logger: Log): Promise<T> {
	const api = new GitpodServerApi(accessToken, serviceUrl, logger);
	return Promise.race([
		cb(api.service),
		new Promise<T>((_, reject) => api.onWillClose(statusCode => {
			if (statusCode === 401) {
				reject(new Error(unauthorizedErr));
			} else {
				reject(new Error('closed'));
			}
		}))
	]).finally(() => api.dispose());
}
