/* eslint-disable code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { Emitter } from 'vs/base/common/event';
import { ILogService } from 'vs/platform/log/common/log';
import { IDisposable } from 'vs/base/common/lifecycle';
import * as yaml from 'js-yaml';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { generateUuid } from 'vs/base/common/uuid';
import { asText, IRequestService } from 'vs/platform/request/common/request';
import { CancellationToken } from 'vs/base/common/cancellation';
import { streamToBuffer } from 'vs/base/common/buffer';

const devMode = !!process.env['VSCODE_DEV'];
const supervisorAddr = process.env.SUPERVISOR_ADDR || 'localhost:22999';

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
	didChangeActiveCliIpcHookEmitter.fire();
}

function setActiveCliIpcHook(cliIpcHook: string): void {
	if (activeCliIpcHook === cliIpcHook) {
		return;
	}
	activeCliIpcHook = cliIpcHook;
	didChangeActiveCliIpcHookEmitter.fire();
}

export function handleGitpodCLIRequest(pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
	if (pathname.startsWith('/cli')) {
		if (req.method === 'GET') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end(activeCliIpcHook);
			return true;
		}
		if (req.method === 'DELETE') {
			const cliIpcHook = decodeURIComponent(pathname.substring('/cli/ipcHookCli/'.length));
			deleteActiveCliIpcHook(cliIpcHook);
			res.writeHead(200);
			res.end();
			return true;
		}
		if (req.method === 'PUT') {
			const cliIpcHook = decodeURIComponent(pathname.substring('/cli/ipcHookCli/'.length));
			setActiveCliIpcHook(cliIpcHook);
			res.writeHead(200);
			res.end();
			return true;
		}
		if (req.method === 'POST') {
			const listener = withActiveCliIpcHook(activeCliIpcHook =>
				req.pipe(http.request({
					socketPath: activeCliIpcHook,
					method: req.method,
					headers: req.headers
				}, res2 => {
					res.setHeader('Content-Type', 'application/json');
					res2.pipe(res);
				}))
			);
			req.on('close', () => listener.dispose());
			return true;
		}
		return false;
	}
	if (devMode && pathname.startsWith('/_supervisor')) {
		const [host, port] = supervisorAddr.split(':');
		req.pipe(http.request({
			host,
			port,
			method: req.method,
			path: pathname
		}, res2 => res2.pipe(res)));
		return true;
	}
	return false;
}

async function downloadInitialExtension(url: string, requestService: IRequestService): Promise<string> {
	const context = await requestService.request({
		type: 'GET', url, headers: {
			'Content-Type': '*/*' // GCP requires that the content-type header match those used during the signing operation (*/* in our case)
		}
	}, CancellationToken.None);
	if (context.res.statusCode !== 200) {
		const message = await asText(context);
		throw new Error(`expected 200, got back ${context.res.statusCode} instead.\n\n${message}`);
	}
	const downloadedLocation = path.join(os.tmpdir(), `${generateUuid()}.vsix`);
	const buffer = await streamToBuffer(context.stream);
	await fs.promises.writeFile(downloadedLocation, buffer.buffer);
	return downloadedLocation;
}

export async function getInitialExtensionsToInstall(logService: ILogService, requestService: IRequestService) {
	const pendingExtensions = async () => {
		const extensions = [];
		try {
			const workspaceContextUrl = process.env.GITPOD_WORKSPACE_CONTEXT_URL;
			if (workspaceContextUrl && /github\.com/i.test(workspaceContextUrl)) {
				extensions.push('github.vscode-pull-request-github');
			}

			const repoRoot = process.env.GITPOD_REPO_ROOT;
			if (repoRoot) {
				let config: { vscode?: { extensions?: string[] } } | undefined;
				try {
					const content = await fs.promises.readFile(path.join(repoRoot, '.gitpod.yml'), 'utf-8');
					config = yaml.safeLoad(content) as any;
				} catch { }

				if (config?.vscode?.extensions) {
					const extensionIdRegex = /^([^.]+\.[^@]+)(@(\d+\.\d+\.\d+(-.*)?))?$/;
					const pendingVsixs = [];
					for (const extension of config.vscode.extensions) {
						const extIdOrUrl = extension.toLocaleLowerCase();
						if (/^http[s]?/.test(extIdOrUrl)) {
							pendingVsixs.push(downloadInitialExtension(extIdOrUrl, requestService).then(vsix => {
								extensions.push(vsix);
							}, e => {
								logService.error(`code server: failed to download initial external extension from '${extIdOrUrl}':`, e);
							}));
						} else if (extensionIdRegex.exec(extIdOrUrl)) {
							extensions.push(extIdOrUrl);
						}
					}
					await Promise.all(pendingVsixs);
				}
			}
		} catch (e) {
			logService.error('code server: failed to detect workspace context dependent extensions:', e);
		}
		return extensions;
	};

	const vsixPaths: string[] = [];
	const pendingVsixs: Promise<void>[] = [];

	if (process.env.GITPOD_RESOLVED_EXTENSIONS) {
		let resolvedPlugins: any = {};
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
			pendingVsixs.push(downloadInitialExtension(resolvedPlugin.url, requestService).then(vsix => {
				vsixPaths.push(vsix);
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
			pendingVsixs.push(downloadInitialExtension(url, requestService).then(vsix => {
				vsixPaths.push(vsix);
			}, e => {
				logService.error(`code server: failed to download initial external extension from '${url}':`, e);
			}));
		}
	}

	await Promise.all(pendingVsixs);
	const extIds = await pendingExtensions();

	return [...vsixPaths, ...extIds];
}
