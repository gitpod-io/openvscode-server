/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vs/vscode.d.ts'/>

import * as grpc from '@grpc/grpc-js';
import * as cp from 'child_process';
import type { GitpodExtension, GitpodExtensionContext, status, terminal } from 'gitpod/src/gitpod';
import * as http from 'http';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
	const gitpodExtension = vscode.extensions.getExtension<GitpodExtension | undefined>('gitpod.gitpod')!.exports;
	if (!gitpodExtension) {
		return;
	}
	const gitpodContext = gitpodExtension.newContext(context);
	if (openWorkspaceLocation(gitpodContext)) {
		return;
	}

	installInitialExtensions(gitpodContext);
	registerHearbeat(gitpodContext);
	registerTasks(gitpodContext);
	registerCLI(gitpodContext);

	// For port tunneling we rely on Remote SSH capabilities
	// and gitpod.gitpod-ui to disable auto tunneling from the current local machine.
	vscode.commands.executeCommand('gitpod-ui.api.autoTunnel', gitpodContext.info.getInstanceId(), false);

	// TODO
	// - auth?
	// - .gitpod.yml validations
	// - add to .gitpod.yml command
	// - cli integration
	//   - git credential helper
	await gitpodContext.active;
}

export function deactivate() { }

export function registerCLI(context: GitpodExtensionContext): void {
	// configure regular terminals
	context.environmentVariableCollection.replace('EDITOR', 'code');
	context.environmentVariableCollection.replace('VISUAL', 'code');
	context.environmentVariableCollection.replace('GP_OPEN_EDITOR', 'code');
	context.environmentVariableCollection.replace('GIT_EDITOR', 'code --wait');
	context.environmentVariableCollection.replace('GP_PREVIEW_BROWSER', `${process.execPath} ${path.join(__dirname, 'cli.js')} --preview`);
	context.environmentVariableCollection.replace('GP_EXTERNAL_BROWSER', 'code --openExternal');

	const ipcHookCli = context.ipcHookCli;
	if (!ipcHookCli) {
		return;
	}
	context.environmentVariableCollection.replace('GITPOD_REMOTE_CLI_IPC', ipcHookCli);

	// configure task terminals if Gitpod Code Server is running
	if (!process.env.GITPOD_THEIA_PORT) {
		return;
	}

	// TODO(ak) fetch ide port from supervisor
	const idePort = Number(process.env.GITPOD_THEIA_PORT);
	async function updateIpcHookCli(): Promise<void> {
		try {
			await new Promise<void>((resolve, reject) => {
				const req = http.request({
					hostname: 'localhost',
					port: idePort,
					protocol: 'http:',
					path: '/cli',
					method: vscode.window.state.focused ? 'PUT' : 'DELETE'
				}, res => {
					const chunks: string[] = [];
					res.setEncoding('utf8');
					res.on('data', d => chunks.push(d));
					res.on('end', () => {
						const result = chunks.join('');
						if (res.statusCode !== 200) {
							reject(new Error(`Bad status code: ${res.statusCode}: ${result}`));
						} else {
							resolve(undefined);
						}
					});
				});
				req.on('error', err => reject(err));
				req.write(ipcHookCli);
				req.end();
			});
		} catch (e) {
			context.output.appendLine('failed to update ipc hook cli: ' + e);
			console.error('failed to update ipc hook cli:', e);
		}
	}
	updateIpcHookCli();
	context.subscriptions.push(vscode.window.onDidChangeWindowState(() => updateIpcHookCli()));
}

export function openWorkspaceLocation(context: GitpodExtensionContext): boolean {
	if (vscode.workspace.workspaceFolders) {
		return false;
	}
	const workspaceUri = vscode.Uri.file(context.info.getWorkspaceLocationFile() || context.info.getWorkspaceLocationFolder());
	vscode.commands.executeCommand('vscode.openFolder', workspaceUri, { forceReuseWindow: true });
	return true;
}

export async function installInitialExtensions(context: GitpodExtensionContext): Promise<void> {
	context.output.appendLine('installing initial extensions...');
	const extensions: (vscode.Uri | string)[] = [];
	try {
		const workspaceContextUri = vscode.Uri.parse(context.info.getWorkspaceContextUrl());
		extensions.push('redhat.vscode-yaml');
		if (/github\.com/i.test(workspaceContextUri.authority)) {
			extensions.push('github.vscode-pull-request-github');
		}

		let config: { vscode?: { extensions?: string[] } } | undefined;
		try {
			const configUri = vscode.Uri.file(path.join(context.info.getCheckoutLocation(), '.gitpod.yml'));
			const buffer = await vscode.workspace.fs.readFile(configUri);
			const content = new util.TextDecoder('utf8').decode(buffer);
			const model = new context.config.GitpodPluginModel(content);
			config = model.document.toJSON();
		} catch { }
		if (config?.vscode?.extensions) {
			const extensionIdRegex = /^([^.]+\.[^@]+)(@(\d+\.\d+\.\d+(-.*)?))?$/;
			for (const extension of config.vscode.extensions) {
				let link: vscode.Uri | undefined;
				try {
					link = vscode.Uri.parse(extension.trim(), true);
					if (link.scheme !== 'http' && link.scheme !== 'https') {
						link = undefined;
					}
				} catch { }
				if (link) {
					extensions.push(link);
				} else {
					const normalizedExtension = extension.toLocaleLowerCase();
					if (extensionIdRegex.exec(normalizedExtension)) {
						extensions.push(normalizedExtension);
					}
				}
			}
		}
	} catch (e) {
		context.output.appendLine('failed to detect workspace context dependent extensions:' + e);
		console.error('failed to detect workspace context dependent extensions:', e);
	}
	context.output.appendLine('initial extensions: ' + extensions);
	if (extensions.length) {
		let cause;
		try {
			const { stderr } = await util.promisify(cp.exec)('code ' + extensions.map(extension => '--install-extension ' + extension).join(' '));
			cause = stderr;
		} catch (e) {
			cause = e;
		}
		if (cause) {
			context.output.appendLine('failed to install initial extensions: ' + cause);
			console.error('failed to install initial extensions: ', cause);
		}
	}
	context.output.appendLine('initial extensions installed');
}

export function registerHearbeat(context: GitpodExtensionContext): void {
	let lastActivity = 0;
	const updateLastActivitiy = () => {
		lastActivity = new Date().getTime();
	};
	const sendHeartBeat = async (wasClosed?: true) => {
		const suffix = wasClosed ? 'was closed heartbeat' : 'heartbeat';
		try {
			context.output.appendLine('sending ' + suffix);
			await context.gitpod.server.sendHeartBeat({ instanceId: context.info.getInstanceId(), wasClosed });
		} catch (err) {
			context.output.appendLine(`failed to send ${suffix}: ` + err);
			console.error(`failed to send ${suffix}`, err);
		}
	};
	sendHeartBeat();
	if (!context.devMode) {
		context.pendingWillCloseSocket.push(() => sendHeartBeat(true));
	}

	let activityInterval = 10000;
	const heartBeatHandle = setInterval(() => {
		if (lastActivity + activityInterval < new Date().getTime()) {
			// no activity, no heartbeat
			return;
		}
		sendHeartBeat();
	}, activityInterval);
	context.subscriptions.push(
		{
			dispose: () => {
				clearInterval(heartBeatHandle);
			}
		},
		vscode.window.onDidChangeActiveTextEditor(updateLastActivitiy),
		vscode.window.onDidChangeVisibleTextEditors(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorSelection(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorVisibleRanges(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorOptions(updateLastActivitiy),
		vscode.window.onDidChangeTextEditorViewColumn(updateLastActivitiy),
		vscode.window.onDidChangeActiveTerminal(updateLastActivitiy),
		vscode.window.onDidOpenTerminal(updateLastActivitiy),
		vscode.window.onDidCloseTerminal(updateLastActivitiy),
		vscode.window.onDidChangeWindowState(updateLastActivitiy),
		vscode.window.onDidChangeActiveColorTheme(updateLastActivitiy),
		vscode.authentication.onDidChangeSessions(updateLastActivitiy),
		vscode.debug.onDidChangeActiveDebugSession(updateLastActivitiy),
		vscode.debug.onDidStartDebugSession(updateLastActivitiy),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(updateLastActivitiy),
		vscode.debug.onDidTerminateDebugSession(updateLastActivitiy),
		vscode.debug.onDidChangeBreakpoints(updateLastActivitiy),
		vscode.extensions.onDidChange(updateLastActivitiy),
		vscode.languages.onDidChangeDiagnostics(updateLastActivitiy),
		vscode.tasks.onDidStartTask(updateLastActivitiy),
		vscode.tasks.onDidStartTaskProcess(updateLastActivitiy),
		vscode.tasks.onDidEndTask(updateLastActivitiy),
		vscode.tasks.onDidEndTaskProcess(updateLastActivitiy),
		vscode.workspace.onDidChangeWorkspaceFolders(updateLastActivitiy),
		vscode.workspace.onDidOpenTextDocument(updateLastActivitiy),
		vscode.workspace.onDidCloseTextDocument(updateLastActivitiy),
		vscode.workspace.onDidChangeTextDocument(updateLastActivitiy),
		vscode.workspace.onWillSaveTextDocument(updateLastActivitiy),
		vscode.workspace.onDidSaveTextDocument(updateLastActivitiy),
		vscode.workspace.onWillCreateFiles(updateLastActivitiy),
		vscode.workspace.onDidCreateFiles(updateLastActivitiy),
		vscode.workspace.onWillDeleteFiles(updateLastActivitiy),
		vscode.workspace.onDidDeleteFiles(updateLastActivitiy),
		vscode.workspace.onWillRenameFiles(updateLastActivitiy),
		vscode.workspace.onDidRenameFiles(updateLastActivitiy),
		vscode.workspace.onDidChangeConfiguration(updateLastActivitiy)
	);
}

async function registerTasks(context: GitpodExtensionContext): Promise<void> {
	const tokenSource = new vscode.CancellationTokenSource();
	const token = tokenSource.token;
	context.subscriptions.push({
		dispose: () => tokenSource.cancel()
	});

	const tasks = new Map<string, status.TaskStatus>();
	let synched = false;
	while (!synched) {
		let listener: vscode.Disposable | undefined;
		try {
			const req = new context.supervisor.TasksStatusRequest();
			req.setObserve(true);
			const stream = context.supervisor.status.tasksStatus(req, context.supervisor.metadata);
			function done() {
				synched = true;
				stream.cancel();
			}
			listener = token.onCancellationRequested(() => done());
			await new Promise((resolve, reject) => {
				stream.on('end', resolve);
				stream.on('error', reject);
				stream.on('data', (response: status.TasksStatusResponse) => {
					if (response.getTasksList().every(status => {
						tasks.set(status.getTerminal(), status);
						return status.getState() !== context.supervisor.TaskState.OPENING;
					})) {
						done();
					}
				});
			});
		} catch (err) {
			if (!('code' in err && err.code === grpc.status.CANCELLED)) {
				console.error('code server: listening task updates failed:', err);
			}
		} finally {
			listener?.dispose();
		}
		if (!synched) {
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
	if (token.isCancellationRequested) {
		return;
	}

	const terminals = new Map<string, terminal.Terminal>();
	try {
		const response = await util.promisify(context.supervisor.terminal.list.bind(context.supervisor.terminal, new context.supervisor.ListTerminalsRequest(), context.supervisor.metadata, {
			deadline: Date.now() + context.supervisor.deadlines.long
		}))();
		for (const terminal of response.getTerminalsList()) {
			terminals.set(terminal.getAlias(), terminal);
		}
	} catch (e) {
		console.error('failed to list terminals:', e);
	}

	for (const alias of tasks.keys()) {
		const terminal = terminals.get(alias);
		if (!terminal) {
			return;
		}
		regsiterTask(alias, terminal.getTitle(), context, token);
	}
}

function regsiterTask(alias: string, initialTitle: string, context: GitpodExtensionContext, contextToken: vscode.CancellationToken): void {
	const tokenSource = new vscode.CancellationTokenSource();
	contextToken.onCancellationRequested(() => tokenSource.cancel());
	const token = tokenSource.token;

	const onDidWriteEmitter = new vscode.EventEmitter<string>();
	const onDidCloseEmitter = new vscode.EventEmitter<void | number>();
	const onDidChangeNameEmitter = new vscode.EventEmitter<string>();
	const toDispose = vscode.Disposable.from(onDidWriteEmitter, onDidCloseEmitter, onDidChangeNameEmitter);
	token.onCancellationRequested(() => toDispose.dispose());

	let pendingWrite = Promise.resolve();
	let pendinResize = Promise.resolve();
	function setDimensions(dimensions: vscode.TerminalDimensions): void {
		if (token.isCancellationRequested) {
			return;
		}
		pendinResize = pendinResize.then(async () => {
			if (token.isCancellationRequested) {
				return;
			}
			try {
				const size = new context.supervisor.TerminalSize();
				size.setCols(dimensions.columns);
				size.setRows(dimensions.rows);

				const request = new context.supervisor.SetTerminalSizeRequest();
				request.setAlias(alias);
				request.setSize(size);
				request.setForce(true);
				await util.promisify(context.supervisor.terminal.setSize.bind(context.supervisor.terminal, request, context.supervisor.metadata, {
					deadline: Date.now() + context.supervisor.deadlines.short
				}))();
			} catch (e) {
				if (e && e.code !== grpc.status.NOT_FOUND) {
					console.error(`${alias} terminal: resize failed:`, e);
				}
			}
		});
	}
	const terminal = vscode.window.createTerminal({
		name: initialTitle,
		pty: {
			onDidWrite: onDidWriteEmitter.event,
			onDidClose: onDidCloseEmitter.event,
			onDidChangeName: onDidChangeNameEmitter.event,
			open: async (dimensions: vscode.TerminalDimensions | undefined) => {
				if (dimensions) {
					setDimensions(dimensions);
				}
				while (!token.isCancellationRequested) {
					let notFound = false;
					let exitCode: number | undefined;
					let listener: vscode.Disposable | undefined;
					try {
						await new Promise((resolve, reject) => {
							const request = new context.supervisor.ListenTerminalRequest();
							request.setAlias(alias);
							const stream = context.supervisor.terminal.listen(request, context.supervisor.metadata);
							listener = token.onCancellationRequested(() => stream.cancel());
							stream.on('end', resolve);
							stream.on('error', reject);
							stream.on('data', (response: terminal.ListenTerminalResponse) => {
								if (response.hasTitle()) {
									const title = response.getTitle();
									if (title) {
										onDidChangeNameEmitter.fire(title);
									}
								} else if (response.hasData()) {
									let data = '';
									const buffer = response.getData();
									if (typeof buffer === 'string') {
										data += buffer;
									} else {
										data += Buffer.from(buffer).toString();
									}
									if (data !== '') {
										onDidWriteEmitter.fire(data);
									}
								} else if (response.hasExitCode()) {
									exitCode = response.getExitCode();
								}
							});
						});
					} catch (e) {
						notFound = 'code' in e && e.code === grpc.status.NOT_FOUND;
						if (!token.isCancellationRequested && !notFound && !('code' in e && e.code === grpc.status.CANCELLED)) {
							console.error(`${alias} terminal: listening failed:`, e);
						}
					} finally {
						listener?.dispose();
					}
					if (token.isCancellationRequested) {
						return;
					}
					if (notFound) {
						onDidCloseEmitter.fire();
					} else if (typeof exitCode === 'number') {
						onDidCloseEmitter.fire(exitCode);
					}
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			},
			close: async () => {
				if (token.isCancellationRequested) {
					return;
				}
				tokenSource.cancel();

				// await to make sure that close is not cause by the extension host process termination
				// in such case we don't want to stop supervisor terminals
				setTimeout(async () => {
					if (contextToken.isCancellationRequested) {
						return;
					}
					// Attempt to kill the pty, it may have already been killed at this
					// point but we want to make sure
					try {
						const request = new context.supervisor.ShutdownTerminalRequest();
						request.setAlias(alias);
						await util.promisify(context.supervisor.terminal.shutdown.bind(context.supervisor.terminal, request, context.supervisor.metadata, {
							deadline: Date.now() + context.supervisor.deadlines.short
						}))();
					} catch (e) {
						if (e && e.code === grpc.status.NOT_FOUND) {
							// Swallow, the pty has already been killed
						} else {
							console.error(`${alias} terminal: shutdown failed:`, e);
						}
					}
				}, 1000);

			},
			handleInput: async (data: string) => {
				if (token.isCancellationRequested) {
					return;
				}
				pendingWrite = pendingWrite.then(async () => {
					if (token.isCancellationRequested) {
						return;
					}
					try {
						const request = new context.supervisor.WriteTerminalRequest();
						request.setAlias(alias);
						request.setStdin(Buffer.from(data, 'utf8'));
						await util.promisify(context.supervisor.terminal.write.bind(context.supervisor.terminal, request, context.supervisor.metadata, {
							deadline: Date.now() + context.supervisor.deadlines.short
						}))();
					} catch (e) {
						if (e && e.code !== grpc.status.NOT_FOUND) {
							console.error(`${alias} terminal: write failed:`, e);
						}
					}
				});
			},
			setDimensions: (dimensions: vscode.TerminalDimensions) => setDimensions(dimensions)
		}
	});
	terminal.show();
}

