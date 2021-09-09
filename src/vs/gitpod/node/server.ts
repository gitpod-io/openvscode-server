/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedPlugins } from '@gitpod/gitpod-protocol';
import { WorkspaceInfoRequest } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import { TasksStatusRequest, TasksStatusResponse, TaskState, TaskStatus } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import * as grpc from '@grpc/grpc-js';
import * as fs from 'fs';
import * as http from 'http';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import { RemoteTerminalChannelServer } from 'vs/gitpod/node/remoteTerminalChannelServer';
import type { ServerExtensionHostConnection } from 'vs/gitpod/node/server-extension-host-connection';
import { infoServiceClient, statusServiceClient, supervisorAddr, supervisorDeadlines, supervisorMetadata } from 'vs/gitpod/node/supervisor-client';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IExtensionGalleryService, IExtensionManagementCLIService, IExtensionManagementService, CURRENT_TARGET_PLATFORM } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementCLIService } from 'vs/platform/extensionManagement/common/extensionManagementCLIService';
import { ExtensionType } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { ILogService } from 'vs/platform/log/common/log';
import { asText, IRequestService } from 'vs/platform/request/common/request';
import { IRawURITransformerFactory, main } from 'vs/server/node/server.main';
import { REMOTE_TERMINAL_CHANNEL_NAME } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import * as rpc from 'vscode-jsonrpc';

const devMode = !!process.env['VSCODE_DEV'];
// TODO(ak) receive from supervisor
let port = undefined;
if (!devMode && process.env.GITPOD_THEIA_PORT) {
	port = Number(process.env.GITPOD_THEIA_PORT);
}

let activeCliIpcHook: string | undefined;
const didChangeActiveCliIpcHookEmitter = new Emitter<void>();
function withActiveCliIpcHook(cb: (activeCliIpcHook: string) => void): IDisposable {
	if (activeCliIpcHook) {
		cb(activeCliIpcHook);
		return { dispose: () => { } };
	}
	const listener = didChangeActiveCliIpcHookEmitter.event(() => {
		if (activeCliIpcHook) {
			listener.dispose();
			cb(activeCliIpcHook);
		}
	});
	return listener;
}
function deleteActiveCliIpcHook(cliIpcHook: string) {
	if (!activeCliIpcHook || activeCliIpcHook !== cliIpcHook) {
		return;
	}
	activeCliIpcHook = undefined;
	didChangeActiveCliIpcHookEmitter.fire(undefined);
}

function setActiveCliIpcHook(cliIpcHook: string): void {
	if (activeCliIpcHook === cliIpcHook) {
		return;
	}
	activeCliIpcHook = cliIpcHook;
	didChangeActiveCliIpcHookEmitter.fire(undefined);
}

const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
main({
	port,
	main: path.join(APP_ROOT, 'out', 'vs', 'gitpod', 'browser', 'workbench', 'workbench.html'),
	mainDev: path.join(APP_ROOT, 'out', 'vs', 'gitpod', 'browser', 'workbench', 'workbench-dev.html'),
	skipExtensions: new Set(['vscode.github-authentication', 'gitpod.gitpod-shared', 'gitpod.gitpod-remote-ssh', 'gitpod.gitpod-desktop']),
	configure: services => {
		services.set(IExtensionManagementCLIService, new SyncDescriptor(ExtensionManagementCLIService));
	},
	start: (accessor, channelServer) => {
		const logService = accessor.get(ILogService);
		channelServer.registerChannel(REMOTE_TERMINAL_CHANNEL_NAME, new RemoteTerminalChannelServer(
			accessor.get(IRawURITransformerFactory),
			logService,
			accessor.get(IConfigurationService),
			(async () => {
				const tasks = new Map<string, TaskStatus>();
				logService.info('code server: synching tasks...');
				let synched = false;
				while (!synched) {
					try {
						const req = new TasksStatusRequest();
						req.setObserve(true);
						const stream = statusServiceClient.tasksStatus(req, supervisorMetadata);
						await new Promise((resolve, reject) => {
							stream.on('end', resolve);
							stream.on('error', reject);
							stream.on('data', (response: TasksStatusResponse) => {
								if (response.getTasksList().every(status => {
									tasks.set(status.getTerminal(), status);
									return status.getState() !== TaskState.OPENING;
								})) {
									synched = true;
									stream.cancel();
								}
							});
						});
					} catch (err) {
						if (!('code' in err && err.code === grpc.status.CANCELLED)) {
							logService.error('code server: listening task updates failed:', err);
						}
					}
					if (!synched) {
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
				}
				logService.info('code server: tasks synched');
				return tasks;
			})()
		));

		const extensionManagementCLIService = accessor.get(IExtensionManagementCLIService);
		const requestService = accessor.get(IRequestService);
		const fileService = accessor.get(IFileService);
		async function downloadInitialExtension(url: string): Promise<URI> {
			const context = await requestService.request({
				type: 'GET', url, headers: {
					'Content-Type': '*/*' // GCP requires that the content-type header match those used during the signing operation (*/* in our case)
				}
			}, CancellationToken.None);
			if (context.res.statusCode !== 200) {
				const message = await asText(context);
				throw new Error(`expected 200, got back ${context.res.statusCode} instead.\n\n${message}`);
			}
			const downloadedLocation = path.join(os.tmpdir(), generateUuid());
			const target = URI.file(downloadedLocation);
			await fileService.writeFile(target, context.stream);
			return target;
		}
		return {
			installingInitialExtensions: (async () => {
				const pendingExtensions = (async () => {
					const extensions = [];
					try {
						// TODO(ak) wait for content ready
						const workspaceInfoResponse = await util.promisify(infoServiceClient.workspaceInfo.bind(infoServiceClient, new WorkspaceInfoRequest(), supervisorMetadata, {
							deadline: Date.now() + supervisorDeadlines.long
						}))();
						const workspaceContextUrl = URI.parse(workspaceInfoResponse.getWorkspaceContextUrl());
						if (/github\.com/i.test(workspaceContextUrl.authority)) {
							extensions.push('github.vscode-pull-request-github');
						}

						let config: { vscode?: { extensions?: string[] } } | undefined;
						try {
							const content = await fs.promises.readFile(path.join(workspaceInfoResponse.getCheckoutLocation(), '.gitpod.yml'), 'utf-8');
							config = yaml.safeLoad(content) as any;
						} catch { }
						if (config?.vscode?.extensions) {
							const extensionIdRegex = /^([^.]+\.[^@]+)(@(\d+\.\d+\.\d+(-.*)?))?$/;
							for (const extension of config.vscode.extensions) {
								const normalizedExtension = extension.toLocaleLowerCase();
								if (extensionIdRegex.exec(normalizedExtension)) {
									extensions.push(normalizedExtension);
								}
							}
						}
					} catch (e) {
						logService.error('code server: failed to detect workspace context dependent extensions:', e);
					}
					return extensions;
				})();

				const vsixs: URI[] = [];
				const pendingVsixs: Promise<void>[] = [];

				if (process.env.GITPOD_RESOLVED_EXTENSIONS) {
					let resolvedPlugins: ResolvedPlugins = {};
					try {
						resolvedPlugins = JSON.parse(process.env.GITPOD_RESOLVED_EXTENSIONS);
					} catch (e) {
						logService.error('code server: failed to parse process.env.GITPOD_RESOLVED_EXTENSIONS:', e);
					}
					for (const pluginId in resolvedPlugins) {
						const resolvedPlugin = resolvedPlugins[pluginId];
						if (resolvedPlugin?.kind !== 'workspace') {
							// ignore built-in extensions configured for Theia, we default to VS Code built-in extensions
							// ignore user extensions installed in Theia, since we switched to the sync storage for them
							continue;
						}
						pendingVsixs.push(downloadInitialExtension(resolvedPlugin.url).then(vsix => {
							vsixs.push(vsix);
						}, e => {
							logService.error(`code server: failed to download initial configured extension from '${resolvedPlugin.url}':`, e);
						}));
					}
				}

				if (process.env.GITPOD_EXTERNAL_EXTENSIONS) {
					let external: string[] = [];
					try {
						external = JSON.parse(process.env.GITPOD_EXTERNAL_EXTENSIONS);
					} catch (e) {
						logService.error('code server: failed to parse process.env.GITPOD_EXTERNAL_EXTENSIONS:', e);
					}
					for (const url of external) {
						pendingVsixs.push(downloadInitialExtension(url).then(vsix => {
							vsixs.push(vsix);
						}, e => {
							logService.error(`code server: failed to download initial external extension from '${url}':`, e);
						}));
					}
				}

				await Promise.all(pendingVsixs);
				// first install resolved by server
				await extensionManagementCLIService.installExtensions(vsixs, [], true, false, {
					log: s => logService.debug(s),
					error: s => logService.error(s)
				}).catch(e => {
					logService.error(`code server: failed to install intial extensions resolved by Gitpod server:`, e);
				});
				// now try to install from .gitpod.yml (it will install only missing extensions)
				await extensionManagementCLIService.installExtensions(await pendingExtensions, [], true, false, {
					log: s => logService.debug(s),
					error: s => logService.error(s)
				}).catch(e => {
					logService.error(`code server: failed to install intial extensions resolved by Code server:`, e);
				});
			})()
		};
	},
	configureExtensionHostForkOptions: (options) => {
		options.env = {
			...options.env,
			GITPOD_CODE_HOST: devMode ? undefined : process.env['GITPOD_HOST']
		};
	},
	configureExtensionHostProcess: (extensionHost, accessor) => {
		const logService = accessor.get(ILogService);
		const extensionGalleryService = accessor.get(IExtensionGalleryService);
		const extensionManagementService = accessor.get(IExtensionManagementService);
		const extensionManagementCLIService = accessor.get(IExtensionManagementCLIService);

		class MessageReader extends rpc.IPCMessageReader {
			override listen(callback: rpc.DataCallback): void {
				super.listen((msg: any) => {
					if ('jsonrpc' in msg) {
						callback(msg);
					}
				});
			}
		}
		const extensionHostConnection = rpc.createMessageConnection(
			new MessageReader(extensionHost),
			new rpc.IPCMessageWriter(extensionHost),
			{
				error: msg => logService.error(msg),
				info: msg => logService.info(msg),
				log: msg => logService.info(msg),
				warn: msg => logService.warn(msg)
			}
		) as any as ServerExtensionHostConnection;

		let extensionHostCliIpcHook: string | undefined;
		function cleanActiveCliIpcHook(): void {
			if (extensionHostCliIpcHook) {
				deleteActiveCliIpcHook(extensionHostCliIpcHook);
			}
		}
		extensionHostConnection.onClose(cleanActiveCliIpcHook);
		extensionHostConnection.onDispose(cleanActiveCliIpcHook);
		extensionHostConnection.onNotification('setActiveCliIpcHook', (cliIpcHook: string | undefined) => {
			if (!cliIpcHook) {
				cleanActiveCliIpcHook();
			} else {
				setActiveCliIpcHook(cliIpcHook);
			}
			extensionHostCliIpcHook = cliIpcHook;
		});
		extensionManagementService.onDidInstallExtensions(() => extensionHostConnection.sendNotification('onDidInstallExtension'));
		extensionManagementService.onDidUninstallExtension(() => extensionHostConnection.sendNotification('onDidUninstallExtension'));

		extensionHostConnection.onRequest('installExtensionFromConfig', id => extensionManagementCLIService.installExtensions([id], [], true, false, {
			log: s => logService.debug(s),
			error: s => logService.error(s)
		}).catch(e => {
			logService.error(`code server: failed to install ${id} extension from .gitpod.yml:`, e);
		}));
		extensionHostConnection.onRequest('validateExtensions', async (param, token) => {
			const links = new Set<string>();
			const extensions = new Set<string>();
			const missingMachined = new Set<string>();
			const lookup = new Set(param.extensions.map(({ id }) => id));
			const uninstalled = new Set<string>([...lookup]);
			lookup.add('github.vscode-pull-request-github');
			const extensionIds = param.extensions.filter(({ version }) => version === undefined).map(({ id }) => ({ id }));
			const extensionsWithIdAndVersion = param.extensions.filter(({ version }) => version !== undefined);
			await Promise.all([
				extensionManagementService.getInstalled(ExtensionType.User).then(extensions => {
					for (const extension of extensions) {
						const id = extension.identifier.id.toLowerCase();
						uninstalled.delete(id);
						if (extension.isMachineScoped && !lookup.has(id)) {
							missingMachined.add(id);
						}
					}
				}, () => { }),
				extensionGalleryService.getExtensions(extensionIds, token).then(result =>
					result.forEach(extension => extensions.add(extension.identifier.id.toLocaleLowerCase())), () => { }),
				...extensionsWithIdAndVersion.map(({ id, version }) =>
					extensionGalleryService.getCompatibleExtension({ id }, CURRENT_TARGET_PLATFORM).
						then(extension => extension && extensions.add(extension.identifier.id.toLocaleLowerCase()), () => { })),
				...param.links.map(async vsix => {
					try {
						await extensionManagementService.getManifest(URI.parse(vsix), token);
						links.add(vsix);
					} catch { }
				}),
			]);
			return {
				extensions: [...extensions],
				links: [...links],
				missingMachined: [...missingMachined],
				uninstalled: [...uninstalled]
			};
		});
		extensionHostConnection.listen();
		return extensionHostConnection;
	},
	handleRequest: async (pathname, req, res) => {
		if (pathname === '/cli') {
			if (req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end(activeCliIpcHook);
				return true;
			}
			if (req.method === 'DELETE') {
				let cliIpcHook = '';
				req.setEncoding('utf8');
				req.on('data', (chunk: string) => cliIpcHook += chunk);
				req.on('end', () => {
					deleteActiveCliIpcHook(cliIpcHook);
					res.writeHead(200);
					res.end();
				});
				return true;
			}
			if (req.method === 'PUT') {
				let cliIpcHook = '';
				req.setEncoding('utf8');
				req.on('data', (chunk: string) => cliIpcHook += chunk);
				req.on('end', () => {
					setActiveCliIpcHook(cliIpcHook);
					res.writeHead(200);
					res.end();
				});
				return true;
			}
			if (req.method === 'POST') {
				const listener = withActiveCliIpcHook(activeCliIpcHook =>
					req.pipe(http.request({
						socketPath: activeCliIpcHook,
						method: req.method,
						headers: req.headers
					}, res2 => res2.pipe(res)))
				);
				req.on('close', () => listener.dispose());
				return true;
			}
			return false;
		}
		if (devMode && pathname?.startsWith('/_supervisor')) {
			const [host, port] = supervisorAddr.split(':');
			req.pipe(http.request({
				host, port,
				method: req.method,
				path: pathname
			}, res2 => res2.pipe(res)));
			return true;
		}
		return false;
	}
});
