import { AutoTunnelRequest, ResolveSSHConnectionRequest, ResolveSSHConnectionResponse } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb';
import { LocalAppClient } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb_service';
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import { grpc } from '@improbable-eng/grpc-web';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import fetch, { Response } from 'node-fetch';
import { Client as sshClient, utils as sshUtils } from 'ssh2';
import * as tmp from 'tmp';
import * as path from 'path';
import * as vscode from 'vscode';
import Log from './common/logger';
import { Disposable } from './common/dispose';
import { withServerApi } from './internalApi';
import TelemetryReporter from './telemetryReporter';
import { addHostToHostFile, checkNewHostInHostkeys } from './common/hostfile';

interface SSHConnectionParams {
	workspaceId: string;
	instanceId: string;
	gitpodHost: string;
}

interface LocalAppConfig {
	gitpodHost: string;
	configFile: string;
	apiPort: number;
	pid: number;
	logPath: string;
}

interface Lock {
	pid?: number;
	value: string;
	deadline: number;
}

interface LocalAppInstallation {
	path: string;
	etag: string | null;
}

// TODO(ak) commands to show logs and stop local apps
// TODO(ak) auto stop local apps if not used for 3 hours

function throwIfCancelled(token?: vscode.CancellationToken): void {
	if (token?.isCancellationRequested) {
		throw new Error('cancelled');
	}
}

const lockPrefix = 'lock/';
const checkStaleInterval = 30000;
const installLockTimeout = 300000;
function isLock(lock: any): lock is Lock {
	return !!lock && typeof lock === 'object';
}

function checkRunning(pid: number): true | Error {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e;
	}
}

class LocalAppError extends Error {
	constructor(cause: Error, readonly logPath?: string) {
		super();
		this.name = cause.name;
		this.message = cause.message;
		this.stack = cause.stack;
	}
}

class SSHError extends Error {
	constructor(cause: Error) {
		super();
		this.name = cause.name;
		this.message = cause.message;
		this.stack = cause.stack;
	}
}

class NoRunningInstanceError extends Error {
	constructor(readonly workspaceId: string) {
		super(`Failed to connect to ${workspaceId} Gitpod workspace, workspace not running`);
	}
}

class NoSSHGatewayError extends Error {
	constructor(readonly host: string) {
		super(`SSH gateway not configured for this Gitpod Host ${host}`);
	}
}

export default class RemoteConnector extends Disposable {

	public static AUTH_COMPLETE_PATH = '/auth-complete';
	private static LOCK_COUNT = 0;

	constructor(private readonly context: vscode.ExtensionContext, private readonly logger: Log, private readonly telemetry: TelemetryReporter) {
		super();

		this.releaseStaleLocks();

		if (vscode.env.remoteName && context.extension.extensionKind === vscode.ExtensionKind.UI) {
			this._register(vscode.commands.registerCommand('gitpod.api.autoTunnel', this.autoTunnelCommand.bind(this)));
		}
	}

	private releaseStaleLocks(): void {
		const releaseLocks = () => {
			for (const key of this.context.globalState.keys()) {
				if (key.startsWith(lockPrefix)) {
					const lock = this.context.globalState.get(key);
					if (!isLock(lock) || Date.now() >= lock.deadline || (typeof lock.pid === 'number' && checkRunning(lock.pid) !== true)) {
						const lockName = key.slice(0, lockPrefix.length);
						this.logger.info(`cancel stale lock: ${lockName}`);
						this.context.globalState.update(key, undefined);
					}
				}
			}
		};

		releaseLocks();
		const releaseStaleLocksTimer = setInterval(releaseLocks, checkStaleInterval);
		this._register(new vscode.Disposable(() => clearInterval(releaseStaleLocksTimer)));
	}

	private async withLock<T>(lockName: string, op: (token: vscode.CancellationToken) => Promise<T>, timeout: number, token?: vscode.CancellationToken): Promise<T> {
		this.logger.info(`acquiring lock: ${lockName}`);
		const lockKey = lockPrefix + lockName;
		const value = vscode.env.sessionId + '/' + RemoteConnector.LOCK_COUNT++;
		let currentLock: Lock | undefined;
		let deadline: number | undefined;
		const updateTimeout = 150;
		while (currentLock?.value !== value) {
			currentLock = this.context.globalState.get<Lock>(lockKey);
			if (!currentLock) {
				deadline = Date.now() + timeout + updateTimeout * 2;
				await this.context.globalState.update(lockKey, <Lock>{ value, deadline, pid: process.pid });
			}
			// TODO(ak) env.globaState.onDidChange instead, see https://github.com/microsoft/vscode/issues/131182
			await new Promise(resolve => setTimeout(resolve, updateTimeout));
			currentLock = this.context.globalState.get<Lock>(lockKey);
		}
		this.logger.info(`acquired lock: ${lockName}`);
		const tokenSource = new vscode.CancellationTokenSource();
		token?.onCancellationRequested(() => tokenSource.cancel());
		let timer = setInterval(() => {
			currentLock = this.context.globalState.get<Lock>(lockKey);
			if (currentLock?.value !== value) {
				tokenSource.cancel();
			}
		}, updateTimeout);
		try {
			const result = await op(tokenSource.token);
			return result;
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			this.logger.info(`released lock: ${lockName}`);
			await this.context.globalState.update(lockKey, undefined);
		}
	}

	private downloadLocalApp(gitpodHost: string): Promise<Response> {
		let downloadUri = vscode.Uri.parse(gitpodHost);
		let arch = '';
		if (process.arch === 'arm64') {
			arch = '-arm64';
		} if (process.arch === 'x32' && process.platform === 'win32') {
			arch = '-386';
		}
		if (process.platform === 'win32') {
			downloadUri = downloadUri.with({
				path: `/static/bin/gitpod-local-companion-windows${arch}.exe`
			});
		} else if (process.platform === 'darwin') {
			downloadUri = downloadUri.with({
				path: `/static/bin/gitpod-local-companion-darwin${arch}`
			});
		} else {
			downloadUri = downloadUri.with({
				path: `/static/bin/gitpod-local-companion-linux${arch}`
			});
		}
		this.logger.info(`fetching the local app from ${downloadUri.toString()}`);
		return fetch(downloadUri.toString());
	}

	private async installLocalApp(download: Response, token: vscode.CancellationToken): Promise<LocalAppInstallation> {
		try {
			const fileExtension = process.platform === 'win32' ? '.exe' : undefined;
			const installationPath = await new Promise<string>((resolve, reject) =>
				tmp.file({ prefix: 'gitpod-local-companion', postfix: fileExtension, keep: true, discardDescriptor: true }, (err, path) => {
					if (err) {
						return reject(err);
					}
					return resolve(path);
				})
			);
			throwIfCancelled(token);
			this.logger.info(`installing the local app to ${installationPath}`);
			const installationStream = fs.createWriteStream(installationPath);
			const cancelInstallationListener = token.onCancellationRequested(() => installationStream.destroy(new Error('cancelled')));
			await new Promise((resolve, reject) => {
				download.body.pipe(installationStream)
					.on('error', reject)
					.on('finish', resolve);
			}).finally(() => {
				cancelInstallationListener.dispose();
				installationStream.destroy();
			});

			throwIfCancelled(token);
			if (process.platform !== 'win32') {
				await fs.promises.chmod(installationPath, '755');
				throwIfCancelled(token);
			}
			const installation: LocalAppInstallation = { path: installationPath, etag: download.headers.get('etag') };
			this.logger.info(`installing the local app: ${JSON.stringify(installation, undefined, 2)}`);
			return installation;
		} catch (e) {
			this.logger.error(`failed to install the local app: ${e}`);
			throw e;
		}
	}

	private async startLocalApp(gitpodHost: string, installation: LocalAppInstallation, token: vscode.CancellationToken): Promise<LocalAppConfig> {
		try {
			const [configFile, apiPort] = await Promise.all([new Promise<string>((resolve, reject) =>
				tmp.file({ prefix: 'gitpod_ssh_config', keep: true, discardDescriptor: true }, (err, path) => {
					if (err) {
						return reject(err);
					}
					return resolve(path);
				})
			), new Promise<number>(resolve => {
				const server = http.createServer();
				server.listen(0, 'localhost', () => {
					resolve((server.address() as net.AddressInfo).port);
					server.close();
				});
			})]);
			throwIfCancelled(token);
			this.logger.info(`starting the local app with the config: ${JSON.stringify({ gitpodHost, configFile: vscode.Uri.file(configFile).toString(), apiPort }, undefined, 2)}`);

			const parsed = path.parse(installation.path);
			const logPath = path.join(parsed.dir, parsed.name) + '.log';
			const logStream = fs.createWriteStream(logPath);
			const cancelLogStreamListener = token.onCancellationRequested(() => logStream.destroy(new Error('cancelled')));
			await new Promise((resolve, reject) => {
				logStream.on('error', reject);
				logStream.on('open', resolve);
			}).finally(() => {
				cancelLogStreamListener.dispose();
			});

			const localAppProcess = cp.spawn(installation.path, {
				detached: true,
				stdio: ['ignore', logStream, logStream],
				env: {
					...process.env,
					GITPOD_HOST: gitpodHost,
					GITPOD_LCA_SSH_CONFIG: configFile,
					GITPOD_LCA_API_PORT: String(apiPort),
					GITPOD_LCA_AUTO_TUNNEL: String(false),
					GITPOD_LCA_AUTH_REDIRECT_URL: `${vscode.env.uriScheme}://${this.context.extension.id}${RemoteConnector.AUTH_COMPLETE_PATH}`,
					GITPOD_LCA_VERBOSE: String(vscode.workspace.getConfiguration('gitpod').get<boolean>('verbose', false)),
					GITPOD_LCA_TIMEOUT: String(vscode.workspace.getConfiguration('gitpod').get<string>('timeout', '3h'))
				}
			});
			localAppProcess.unref();
			const cancelLocalAppProcessListener = token.onCancellationRequested(() => localAppProcess.kill());
			const pid = await new Promise<number>((resolve, reject) => {
				localAppProcess.on('error', reject);
				localAppProcess.on('exit', code => reject(new Error('unexpectedly exit with code: ' + code)));
				localAppProcess.on('spawn', () => resolve(localAppProcess.pid!));
			}).finally(() => {
				cancelLocalAppProcessListener.dispose();
			});

			this.logger.info(`the local app has been stared: ${JSON.stringify({ pid, log: vscode.Uri.file(logPath).toString() }, undefined, 2)}`);
			return { gitpodHost, configFile, apiPort, pid, logPath };
		} catch (e) {
			this.logger.error(`failed to start the local app: ${e}`);
			throw e;
		}
	}

	/**
	 * Important: it should not call the local app to manage in 30sec
	 */
	private async ensureLocalApp(gitpodHost: string, configKey: string, installationKey: string, token: vscode.CancellationToken): Promise<LocalAppConfig> {
		let config = this.context.globalState.get<LocalAppConfig>(configKey);
		let installation = this.context.globalState.get<LocalAppInstallation>(installationKey);

		if (config && checkRunning(config?.pid) !== true) {
			config = undefined;
		}

		const gitpodConfig = vscode.workspace.getConfiguration('gitpod');
		const configuredInstallationPath = gitpodConfig.get<string>('installationPath');
		if (configuredInstallationPath) {
			if (installation && installation.path !== configuredInstallationPath) {
				this.logger.info(`the local app is different from configured, switching: ${JSON.stringify({ installed: installation.path, configured: configuredInstallationPath }, undefined, 2)}`);
				installation = undefined;
				if (config) {
					try {
						process.kill(config.pid);
					} catch (e) {
						this.logger.error(`failed to kill the outdated local app (pid: ${config.pid}): ${e}`);
					}
				}
				config = undefined;
			}
			if (config) {
				return config;
			}
			await fs.promises.access(configuredInstallationPath, fs.constants.X_OK);
			throwIfCancelled(token);
			installation = { path: configuredInstallationPath, etag: null };
			await this.context.globalState.update(installationKey, installation);
			throwIfCancelled(token);
		} else {
			let download: Response | Error;
			try {
				download = await this.downloadLocalApp(gitpodHost);
				throwIfCancelled(token);
				if (!download.ok) {
					download = new Error(`unexpected download response ${download.statusText} (${download.status})`);
				}
			} catch (e) {
				download = e;
			}
			if (installation) {
				const upgrade = !(download instanceof Error) && { etag: download.headers.get('etag'), url: download.url };
				if (upgrade && upgrade.etag && upgrade.etag !== installation.etag) {
					this.logger.info(`the local app is outdated, upgrading: ${JSON.stringify({ installation, upgrade }, undefined, 2)}`);
					installation = undefined;
					if (config) {
						try {
							process.kill(config.pid);
						} catch (e) {
							this.logger.error(`failed to kill the outdated local app (pid: ${config.pid}): ${e}`);
						}
					}
					config = undefined;
				}
			}
			if (config) {
				return config;
			}
			if (installation) {
				try {
					await fs.promises.access(installation.path, fs.constants.X_OK);
				} catch {
					installation = undefined;
				}
				throwIfCancelled(token);
			}
			if (!installation) {
				if (download instanceof Error) {
					throw download;
				}
				installation = await this.installLocalApp(download, token);
				await this.context.globalState.update(installationKey, installation);
				throwIfCancelled(token);
			}
		}
		config = await this.startLocalApp(gitpodHost, installation, token);
		await this.context.globalState.update(configKey, config);
		throwIfCancelled(token);
		return config;
	}

	private async withLocalApp<T>(gitpodHost: string, op: (client: LocalAppClient, config: LocalAppConfig) => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
		const gitpodAuthority = vscode.Uri.parse(gitpodHost).authority;
		const configKey = 'config/' + gitpodAuthority;
		const installationKey = 'installation/' + gitpodAuthority;
		const config = await this.withLock(gitpodAuthority, token =>
			this.ensureLocalApp(gitpodHost, configKey, installationKey, token)
			, installLockTimeout, token);
		throwIfCancelled(token);
		while (true) {
			const client = new LocalAppClient('http://localhost:' + config.apiPort, { transport: NodeHttpTransport() });
			try {
				const result = await op(client, config);
				throwIfCancelled(token);
				return result;
			} catch (e) {
				throwIfCancelled(token);
				const running = checkRunning(config.pid);
				if (running === true && (e.code === grpc.Code.Unavailable || e.code === grpc.Code.Unknown)) {
					this.logger.info(`the local app (pid: ${config.pid}) is running, but the api endpoint is not ready: ${e}`);
					this.logger.info(`retying again after 1s delay...`);
					await new Promise(resolve => setTimeout(resolve, 1000));
					throwIfCancelled(token);
					continue;
				}
				if (running !== true) {
					this.logger.info(`the local app (pid: ${config.pid}) is not running: ${running}`);
				}
				this.logger.error(`failed to access the local app: ${e}`);
				throw e;
			}
		}
	}

	private async getWorkspaceSSHDestination(workspaceId: string, gitpodHost: string): Promise<string> {
		const session = await vscode.authentication.getSession(
			'gitpod',
			['function:getWorkspace', 'function:getOwnerToken', 'function:getLoggedInUser', 'resource:default'],
			{ createIfNone: true }
		);

		const serviceUrl = new URL(gitpodHost);

		const workspaceInfo = await withServerApi(session.accessToken, serviceUrl.toString(), service => service.server.getWorkspace(workspaceId), this.logger);
		if (workspaceInfo.latestInstance?.status?.phase !== 'running') {
			throw new NoRunningInstanceError(workspaceId);
		}

		const workspaceUrl = new URL(workspaceInfo.latestInstance.ideUrl);

		const sshHostKeyEndPoint = `https://${workspaceUrl.host}/_ssh/host_keys`;
		const sshHostKeyResponse = await fetch(sshHostKeyEndPoint);
		if (!sshHostKeyResponse.ok) {
			// Gitpod SSH gateway not configured
			throw new NoSSHGatewayError(gitpodHost);
		}

		const sshHostKeys: { type: string; host_key: string }[] = await sshHostKeyResponse.json();

		const ownerToken = await withServerApi(session.accessToken, serviceUrl.toString(), service => service.server.getOwnerToken(workspaceId), this.logger);

		const sshDestInfo = {
			user: `${workspaceId}#${ownerToken}`,
			// See https://github.com/gitpod-io/gitpod/pull/9786 for reasoning about `.ssh` suffix
			hostName: workspaceUrl.host.replace(workspaceId, `${workspaceId}.ssh`)
		};

		let verifiedHostKey: Buffer | undefined;
		// Test ssh connection first
		await new Promise<void>((resolve, reject) => {
			const conn = new sshClient();
			conn.on('ready', () => {
				conn.end();
				resolve();
			}).on('error', err => {
				reject(new SSHError(err));
			}).connect({
				host: sshDestInfo.hostName,
				username: sshDestInfo.user,
				authHandler(_methodsLeft, _partialSuccess, _callback) {
					return {
						type: 'password',
						username: workspaceId,
						password: ownerToken,
					};
				},
				hostVerifier(hostKey) {
					// We didn't specify `hostHash` so `hashedKey` is a Buffer object
					verifiedHostKey = (hostKey as any as Buffer);
					const encodedKey = verifiedHostKey.toString('base64');
					return sshHostKeys.some(keyData => keyData.host_key === encodedKey);
				}
			});
		});
		this.logger.info(`SSH test connection to '${sshDestInfo.hostName}' host successful`);

		// SSH connection successful, write host to known_hosts
		try {
			const result = sshUtils.parseKey(verifiedHostKey!);
			if (result instanceof Error) {
				throw result;
			}
			const parseKey = Array.isArray(result) ? result[0] : result;
			if (parseKey && await checkNewHostInHostkeys(sshDestInfo.hostName)) {
				await addHostToHostFile(sshDestInfo.hostName, verifiedHostKey!, parseKey.type);
				this.logger.info(`'${sshDestInfo.hostName}' host added to known_hosts file`);
			}
		} catch (e) {
			this.logger.error(`Couldn't write '${sshDestInfo.hostName}' host to known_hosts file`, e);
		}

		return Buffer.from(JSON.stringify(sshDestInfo), 'utf8').toString('hex');
	}

	private async getWorkspaceLocalAppSSHDestination(params: SSHConnectionParams): Promise<{ localAppSSHDest: string; localAppSSHConfigPath: string }> {
		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
			title: `Connecting to ${params.workspaceId} Gitpod workspace`
		}, async (_, token) => {
			let localAppLogPath: string | undefined;
			try {
				const connection = await this.withLocalApp(params.gitpodHost, (client, config) => {
					localAppLogPath = config.logPath;

					const request = new ResolveSSHConnectionRequest();
					request.setInstanceId(params.instanceId);
					request.setWorkspaceId(params.workspaceId);
					return new Promise<ResolveSSHConnectionResponse>((resolve, reject) =>
						client.resolveSSHConnection(request, (e, r) => r ? resolve(r) : reject(e))
					);
				}, token);

				return {
					localAppSSHDest: connection.getHost(),
					localAppSSHConfigPath: connection.getConfigFile()
				};
			} catch (e) {
				if (e instanceof Error && e.message === 'cancelled') {
					throw e;
				}

				throw new LocalAppError(e, localAppLogPath);
			}
		});
	}

	private async updateRemoteSSHConfig(usingSSHGateway: boolean, localAppSSHConfigPath: string | undefined) {
		const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
		const defaultExtConfigInfo = remoteSSHconfig.inspect<string[]>('defaultExtensions');
		const defaultExtensions = defaultExtConfigInfo?.globalValue ?? [];
		if (!defaultExtensions.includes('gitpod.gitpod-remote-ssh')) {
			defaultExtensions.unshift('gitpod.gitpod-remote-ssh');
			await remoteSSHconfig.update('defaultExtensions', defaultExtensions, vscode.ConfigurationTarget.Global);
		}

		const currentConfigFile = remoteSSHconfig.get<string>('configFile');
		if (usingSSHGateway) {
			if (currentConfigFile?.includes('gitpod_ssh_config')) {
				await remoteSSHconfig.update('configFile', undefined, vscode.ConfigurationTarget.Global);
			}
		} else {
			// TODO(ak) notify a user about config file changes?
			if (currentConfigFile === localAppSSHConfigPath) {
				// invalidate cached SSH targets from the current config file
				await remoteSSHconfig.update('configFile', undefined, vscode.ConfigurationTarget.Global);
			}
			await remoteSSHconfig.update('configFile', localAppSSHConfigPath, vscode.ConfigurationTarget.Global);
		}
	}

	private async ensureRemoteSSHExtInstalled(): Promise<boolean> {
		const msVscodeRemoteExt = vscode.extensions.getExtension('ms-vscode-remote.remote-ssh');
		if (msVscodeRemoteExt) {
			return true;
		}

		const install = 'Install';
		const cancel = 'Cancel';
		const action = await vscode.window.showInformationMessage('Please install "Remote - SSH" extension to connect to a Gitpod workspace.', install, cancel);
		if (action === cancel) {
			return false;
		}

		this.logger.info('Installing "ms-vscode-remote.remote-ssh" extension');

		await vscode.commands.executeCommand('extension.open', 'ms-vscode-remote.remote-ssh');
		await vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode-remote.remote-ssh');

		return true;
	}

	public async handleUri(uri: vscode.Uri) {
		if (uri.path === RemoteConnector.AUTH_COMPLETE_PATH) {
			this.logger.info('auth completed');
			return;
		}

		const isRemoteSSHExtInstalled = this.ensureRemoteSSHExtInstalled();
		if (!isRemoteSSHExtInstalled) {
			return;
		}

		const gitpodHost = vscode.workspace.getConfiguration('gitpod').get<string>('host')!;
		const forceUseLocalApp = vscode.workspace.getConfiguration('gitpod').get<boolean>('remote.useLocalApp')!;

		const params: SSHConnectionParams = JSON.parse(uri.query);
		if (new URL(params.gitpodHost).host !== new URL(gitpodHost).host) {
			const yes = 'Yes';
			const cancel = 'Cancel';
			const action = await vscode.window.showInformationMessage(`Connecting to a Gitpod workspace in '${params.gitpodHost}'. Would you like to switch from '${gitpodHost}' and continue?`, yes, cancel);
			if (action === cancel) {
				return;
			}

			await vscode.workspace.getConfiguration('gitpod').update('host', params.gitpodHost, vscode.ConfigurationTarget.Global);
			this.logger.info(`Updated 'gitpod.host' setting to '${params.gitpodHost}' while trying to connect to a Gitpod workspace`);
		}

		this.logger.info('Opening Gitpod workspace', uri.toString());

		let sshDestination: string | undefined;
		if (!forceUseLocalApp) {
			try {
				this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'gateway', status: 'connecting' });

				sshDestination = await this.getWorkspaceSSHDestination(params.workspaceId, params.gitpodHost);

				this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'gateway', status: 'connected' });
			} catch (e) {
				this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'gateway', status: 'failed', reason: e.toString() });
				if (e instanceof NoSSHGatewayError) {
					this.logger.error('No SSH gateway', e);
					vscode.window.showWarningMessage(`${e.host} does not support [direct SSH access](https://github.com/gitpod-io/gitpod/blob/main/install/installer/docs/workspace-ssh-access.md), connecting via the deprecated SSH tunnel over WebSocket.`);
					// Do nothing and continue execution
				} else if (e instanceof NoRunningInstanceError) {
					this.logger.error('No Running instance', e);
					vscode.window.showErrorMessage(`Failed to connect to ${e.workspaceId} Gitpod workspace: workspace not running`);
					return;
				} else {
					if (e instanceof SSHError) {
						this.logger.error('SSH test connection error', e);
					} else {
						this.logger.error(`Failed to connect to ${params.workspaceId} Gitpod workspace`, e);
					}
					const seeLogs = 'See Logs';
					const showTroubleshooting = 'Show Troubleshooting';
					const action = await vscode.window.showErrorMessage(`Failed to connect to ${params.workspaceId} Gitpod workspace`, seeLogs, showTroubleshooting);
					if (action === seeLogs) {
						this.logger.show();
					} else if (action === showTroubleshooting) {
						vscode.env.openExternal(vscode.Uri.parse('https://www.gitpod.io/docs/ides-and-editors/vscode#vs-code-desktop-ssh-access'));
					}
					return;
				}
			}
		}

		const usingSSHGateway = !!sshDestination;
		let localAppSSHConfigPath: string | undefined;
		if (!usingSSHGateway) {
			try {
				this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'local-app', status: 'connecting' });

				const localAppDestData = await this.getWorkspaceLocalAppSSHDestination(params);
				sshDestination = localAppDestData.localAppSSHDest;
				localAppSSHConfigPath = localAppDestData.localAppSSHConfigPath;

				this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'local-app', status: 'connected' });
			} catch (e) {
				this.logger.error(`Failed to connect ${params.workspaceId} Gitpod workspace`, e);
				if (e instanceof LocalAppError) {
					this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'local-app', status: 'failed', reason: e.toString() });
					const seeLogs = 'See Logs';
					const showTroubleshooting = 'Show Troubleshooting';
					const action = await vscode.window.showErrorMessage(`Failed to connect to ${params.workspaceId} Gitpod workspace`, seeLogs, showTroubleshooting);
					if (action === seeLogs) {
						this.logger.show();
						if (e.logPath) {
							const document = await vscode.workspace.openTextDocument(vscode.Uri.file(e.logPath));
							vscode.window.showTextDocument(document);
						}
					} else if (action === showTroubleshooting) {
						vscode.env.openExternal(vscode.Uri.parse('https://www.gitpod.io/docs/ides-and-editors/vscode#vs-code-desktop-ssh-access'));
					}
				} else {
					// Do nothing, user cancelled the operation
					this.telemetry.sendTelemetryEvent('vscode_desktop_ssh', { kind: 'local-app', status: 'failed', reason: 'cancelled' });
				}
				return;
			}
		}

		await this.updateRemoteSSHConfig(usingSSHGateway, localAppSSHConfigPath);

		vscode.commands.executeCommand(
			'vscode.openFolder',
			vscode.Uri.parse(`vscode-remote://ssh-remote+${sshDestination}${uri.path || '/'}`),
			{ forceNewWindow: true }
		);
	}

	public async autoTunnelCommand(gitpodHost: string, instanceId: string, enabled: boolean) {
		try {
			await this.withLocalApp(gitpodHost, client => {
				const request = new AutoTunnelRequest();
				request.setInstanceId(instanceId);
				request.setEnabled(enabled);
				return new Promise<void>((resolve, reject) =>
					client.autoTunnel(request, (e, r) => r ? resolve(undefined) : reject(e))
				);
			});
		} catch (e) {
			this.logger.error('failed to disable auto tunneling', e);
		}
	}
}
