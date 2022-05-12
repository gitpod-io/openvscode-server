/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';
import { Keychain } from './common/keychain';
import { GitpodServer } from './gitpodServer';
import Log from './common/logger';
import { arrayEquals } from './common/utils';
import { Disposable } from './common/dispose';
import TelemetryReporter from './telemetryReporter';

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

export default class GitpodAuthenticationProvider extends Disposable implements vscode.AuthenticationProvider {
	private _sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	private _logger: Log;
	private _telemetry: TelemetryReporter;
	private _gitpodServer: GitpodServer;
	private _keychain: Keychain;

	private _sessionsPromise: Promise<vscode.AuthenticationSession[]>;

	constructor(private readonly context: vscode.ExtensionContext, logger: Log, telemetry: TelemetryReporter) {
		super();

		this._logger = logger;
		this._telemetry = telemetry;

		const gitpodHost = vscode.workspace.getConfiguration('gitpod').get<string>('host')!;
		const serviceUrl = new URL(gitpodHost);
		this._gitpodServer = new GitpodServer(serviceUrl.toString(), this._logger);
		this._keychain = new Keychain(this.context, `gitpod.auth.${serviceUrl.hostname}`, this._logger);
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('gitpod.host')) {
				const gitpodHost = vscode.workspace.getConfiguration('gitpod').get<string>('host')!;
				const serviceUrl = new URL(gitpodHost);
				this._gitpodServer.dispose();
				this._gitpodServer = new GitpodServer(serviceUrl.toString(), this._logger);
				this._keychain = new Keychain(this.context, `gitpod.auth.${serviceUrl.hostname}`, this._logger);

				this.checkForUpdates();
			}
		}));

		// Contains the current state of the sessions we have available.
		this._sessionsPromise = this.readSessions();

		this._register(vscode.authentication.registerAuthenticationProvider('gitpod', 'Gitpod', this, { supportsMultipleAccounts: false }));
		this._register(this.context.secrets.onDidChange(() => this.checkForUpdates()));
	}

	get onDidChangeSessions() {
		return this._sessionChangeEmitter.event;
	}

	async getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
		// For the Gitpod scope list, order doesn't matter so we immediately sort the scopes
		const sortedScopes = scopes?.sort() || [];
		this._logger.info(`Getting sessions for ${sortedScopes.length ? sortedScopes.join(',') : 'all scopes'}...`);
		const sessions = await this._sessionsPromise;
		const finalSessions = sortedScopes.length
			? sessions.filter(session => arrayEquals([...session.scopes].sort(), sortedScopes))
			: sessions;

		this._logger.info(`Got ${finalSessions.length} sessions for ${sortedScopes?.join(',') ?? 'all scopes'}...`);
		return finalSessions;
	}

	private async checkForUpdates() {
		const previousSessions = await this._sessionsPromise;
		this._sessionsPromise = this.readSessions();
		const storedSessions = await this._sessionsPromise;

		const added: vscode.AuthenticationSession[] = [];
		const removed: vscode.AuthenticationSession[] = [];

		storedSessions.forEach(session => {
			const matchesExisting = previousSessions.some(s => s.id === session.id);
			// Another window added a session to the keychain, add it to our state as well
			if (!matchesExisting) {
				this._logger.info('Adding session found in keychain');
				added.push(session);
			}
		});

		previousSessions.forEach(session => {
			const matchesExisting = storedSessions.some(s => s.id === session.id);
			// Another window has logged out, remove from our state
			if (!matchesExisting) {
				this._logger.info('Removing session no longer found in keychain');
				removed.push(session);
			}
		});

		if (added.length || removed.length) {
			this._sessionChangeEmitter.fire({ added, removed, changed: [] });
		}
	}

	private async readSessions(): Promise<vscode.AuthenticationSession[]> {
		let sessionData: SessionData[];
		try {
			this._logger.info('Reading sessions from keychain...');
			const storedSessions = await this._keychain.getToken();
			if (!storedSessions) {
				return [];
			}
			this._logger.info('Got stored sessions!');

			try {
				sessionData = JSON.parse(storedSessions);
			} catch (e) {
				await this._keychain.deleteToken();
				throw e;
			}
		} catch (e) {
			this._logger.error(`Error reading token: ${e}`);
			return [];
		}

		const sessionPromises = sessionData.map(async (session: SessionData) => {
			// For the Gitpod scope list, order doesn't matter so we immediately sort the scopes
			const sortedScopes = session.scopes.sort();
			const scopesStr = sortedScopes.join(' ');

			let userInfo: { id: string; accountName: string } | undefined;
			if (!session.account) {
				try {
					userInfo = await this._gitpodServer.getUserInfo(session.accessToken);
					this._logger.info(`Verified session with the following scopes: ${scopesStr}`);
				} catch (e) {
					// Remove sessions that return unauthorized response
					if (e.message === 'Unauthorized') {
						return undefined;
					}
				}
			}

			this._logger.trace(`Read the following session from the keychain with the following scopes: ${scopesStr}`);
			return {
				id: session.id,
				account: {
					label: session.account
						? session.account.label ?? session.account.displayName ?? '<unknown>'
						: userInfo?.accountName ?? '<unknown>',
					id: session.account?.id ?? userInfo?.id ?? '<unknown>'
				},
				scopes: sortedScopes,
				accessToken: session.accessToken
			};
		});

		const verifiedSessions = (await Promise.allSettled(sessionPromises))
			.filter(p => p.status === 'fulfilled')
			.map(p => (p as PromiseFulfilledResult<vscode.AuthenticationSession | undefined>).value)
			.filter(<T>(p?: T): p is T => Boolean(p));

		this._logger.info(`Got ${verifiedSessions.length} verified sessions.`);
		if (verifiedSessions.length !== sessionData.length) {
			await this.storeSessions(verifiedSessions);
		}

		return verifiedSessions;
	}

	private async storeSessions(sessions: vscode.AuthenticationSession[]): Promise<void> {
		this._logger.info(`Storing ${sessions.length} sessions...`);
		this._sessionsPromise = Promise.resolve(sessions);
		await this._keychain.setToken(JSON.stringify(sessions));
		this._logger.info(`Stored ${sessions.length} sessions!`);
	}

	public async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
		try {
			// For the Gitpod scope list, order doesn't matter so we immediately sort the scopes
			const sortedScopes = scopes.sort();

			this._telemetry.sendTelemetryEvent('gitpod_desktop_auth', {
				kind: 'login',
				scopes: JSON.stringify(sortedScopes),
			});

			const scopeString = sortedScopes.join(' ');
			const token = await this._gitpodServer.login(scopeString);
			const session = await this.tokenToSession(token, sortedScopes);

			const sessions = await this._sessionsPromise;
			const sessionIndex = sessions.findIndex(s => s.id === session.id || arrayEquals([...s.scopes].sort(), sortedScopes));
			if (sessionIndex > -1) {
				sessions.splice(sessionIndex, 1, session);
			} else {
				sessions.push(session);
			}
			await this.storeSessions(sessions);

			this._sessionChangeEmitter.fire({ added: [session], removed: [], changed: [] });

			this._logger.info('Login success!');

			this._telemetry.sendTelemetryEvent('gitpod_desktop_auth', { kind: 'login_successful' });

			return session;
		} catch (e) {
			// If login was cancelled, do not notify user.
			if (e === 'Cancelled' || e.message === 'Cancelled') {
				this._telemetry.sendTelemetryEvent('gitpod_desktop_auth', { kind: 'login_cancelled' });
				throw e;
			}

			this._telemetry.sendTelemetryEvent('gitpod_desktop_auth', { kind: 'login_failed' });

			vscode.window.showErrorMessage(`Sign in failed: ${e}`);
			this._logger.error(e);
			throw e;
		}
	}

	private async tokenToSession(token: string, scopes: string[]): Promise<vscode.AuthenticationSession> {
		const userInfo = await this._gitpodServer.getUserInfo(token);
		return {
			id: uuid(),
			accessToken: token,
			account: { label: userInfo.accountName, id: userInfo.id },
			scopes
		};
	}

	public async removeSession(id: string) {
		try {
			this._telemetry.sendTelemetryEvent('gitpod_desktop_auth', { kind: 'logout' });

			this._logger.info(`Logging out of ${id}`);

			const sessions = await this._sessionsPromise;
			const sessionIndex = sessions.findIndex(session => session.id === id);
			if (sessionIndex > -1) {
				const session = sessions[sessionIndex];
				sessions.splice(sessionIndex, 1);

				await this.storeSessions(sessions);

				this._sessionChangeEmitter.fire({ added: [], removed: [session], changed: [] });
			} else {
				this._logger.error('Session not found');
			}
		} catch (e) {
			this._telemetry.sendTelemetryEvent('gitpod_desktop_auth', { kind: 'logout_failed' });

			vscode.window.showErrorMessage(`Sign out failed: ${e}`);
			this._logger.error(e);
			throw e;
		}
	}

	public handleUri(uri: vscode.Uri) {
		this._gitpodServer.hadleUri(uri);
	}

	public override dispose() {
		super.dispose();
		this._gitpodServer.dispose();
	}
}
