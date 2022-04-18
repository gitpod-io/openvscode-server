/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { TaskStatus } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { ListTerminalsRequest, TerminalTitleSource } from '@gitpod/supervisor-api-grpc/lib/terminal_pb';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { TernarySearchTree } from 'vs/base/common/map';
import * as platform from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { IRawURITransformer, transformIncomingURIs, transformOutgoingURIs, URITransformer } from 'vs/base/common/uriIpc';
import { getSystemShellSync } from 'vs/base/node/shell';
import { IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { supervisorDeadlines, supervisorMetadata, terminalServiceClient } from 'vs/gitpod/node/supervisor-client';
import { OpenSupervisorTerminalProcessOptions, SupervisorTerminalProcess } from 'vs/gitpod/node/supervisorTerminalProcess';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ILogService } from 'vs/platform/log/common/log';
import product from 'vs/platform/product/common/product';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { RequestStore } from 'vs/platform/terminal/common/requestStore';
import { IProcessDataEvent, IRawTerminalTabLayoutInfo, IRequestResolveVariablesEvent, IShellLaunchConfig, ITerminalLaunchError, ITerminalsLayoutInfo, ITerminalTabLayoutInfoById, TerminalIcon, TitleEventSource } from 'vs/platform/terminal/common/terminal';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, IPtyHostProcessReplayEvent, ISetTerminalLayoutInfoArgs } from 'vs/platform/terminal/common/terminalProcess';
import { detectAvailableProfiles } from 'vs/platform/terminal/node/terminalProfiles';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariable';
import { MergedEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableCollection';
import { deserializeEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableShared';
import { ICreateTerminalProcessArguments, ICreateTerminalProcessResult, IWorkspaceFolderData } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { IRemoteTerminalAttachTarget } from 'vs/workbench/contrib/terminal/common/terminal';
import * as terminalEnvironment from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { AbstractVariableResolverService } from 'vs/workbench/services/configurationResolver/common/variableResolver';

type TerminalOpenMode = 'split-top' | 'split-left' | 'split-right' | 'split-bottom' | 'tab-before' | 'tab-after';
const defaultOpenMode: TerminalOpenMode = 'tab-after';
const terminalOpenModes: Set<TerminalOpenMode> = new Set(['split-top', 'split-left', 'split-right', 'split-bottom', 'tab-before', 'tab-after']);
function asTerminalOpenMode(mode: any): TerminalOpenMode {
	if (terminalOpenModes.has(mode)) {
		return mode;
	}
	return defaultOpenMode;
}

/**
 * See ExtHostVariableResolverService in src/vs/workbench/api/common/extHostDebugService.ts for a reference implementation.
 */
class RemoteTerminalVariableResolverService extends AbstractVariableResolverService {

	private readonly structure = TernarySearchTree.forUris<IWorkspaceFolder>(() => false);

	constructor(folders: IWorkspaceFolder[], resolvedVariables: { [name: string]: string }, activeFileResource: URI | undefined, env: platform.IProcessEnvironment) {
		super({
			getFolderUri: (folderName: string): URI | undefined => {
				const found = folders.filter(f => f.name === folderName);
				if (found && found.length > 0) {
					return found[0].uri;
				}
				return undefined;
			},
			getWorkspaceFolderCount: (): number => {
				return folders.length;
			},
			getConfigurationValue: (folderUri: URI | undefined, section: string): string | undefined => {
				return resolvedVariables['config:' + section];
			},
			getAppRoot: (): string | undefined => {
				return env['VSCODE_CWD'] || process.cwd();
			},
			getExecPath: (): string | undefined => {
				return env['VSCODE_EXEC_PATH'];
			},
			getFilePath: (): string | undefined => {
				if (activeFileResource) {
					return path.normalize(activeFileResource.fsPath);
				}
				return undefined;
			},
			getWorkspaceFolderPathForFile: (): string | undefined => {
				if (activeFileResource) {
					const ws = this.structure.findSubstr(activeFileResource);
					if (ws) {
						return path.normalize(ws.uri.fsPath);
					}
				}
				return undefined;
			},
			getSelectedText: (): string | undefined => {
				return resolvedVariables.selectedText;
			},
			getLineNumber: (): string | undefined => {
				return resolvedVariables.lineNumber;
			}
		}, undefined, Promise.resolve(env));

		// setup the workspace folder data structure
		folders.forEach(folder => {
			this.structure.set(folder.uri, folder);
		});
	}

}
const toWorkspaceFolder = (data: IWorkspaceFolderData) => ({
	uri: URI.revive(data.uri),
	name: data.name,
	index: data.index,
	toResource: () => {
		throw new Error('Not implemented');
	}
});

export class RemoteTerminalChannelServer implements IServerChannel<RemoteAgentConnectionContext> {
	private terminalIdSeq = 1;
	private readonly terminalProcesses = new Map<number, SupervisorTerminalProcess>();
	private readonly aliasToId = new Map<string, number>();
	private readonly layoutInfo = new Map<string, ITerminalTabLayoutInfoById[]>();

	private readonly _resolveVariablesRequestStore: RequestStore<string[], { workspaceId: string, originalText: string[] }>;
	private readonly _detachInstanceRequestStore: RequestStore<IProcessDetails | undefined, { workspaceId: string, instanceId: number }>;

	private readonly _onProcessData = new Emitter<{ id: number, event: IProcessDataEvent | string }>();
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessExit = new Emitter<{ id: number, event: number | undefined }>();
	readonly onProcessExit = this._onProcessExit.event;
	private readonly _onProcessReady = new Emitter<{ id: number, event: { pid: number, cwd: string } }>();
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onProcessReplay = new Emitter<{ id: number, event: IPtyHostProcessReplayEvent }>();
	readonly onProcessReplay = this._onProcessReplay.event;
	private readonly _onProcessTitleChanged = new Emitter<{ id: number, event: string }>();
	readonly onProcessTitleChanged = this._onProcessTitleChanged.event;
	private readonly _onPtyHostRequestResolveVariables = new Emitter<IRequestResolveVariablesEvent>();
	readonly onPtyHostRequestResolveVariables = this._onPtyHostRequestResolveVariables.event;
	private readonly _onDidRequestDetach = new Emitter<{ requestId: number, workspaceId: string, instanceId: number }>();
	readonly onDidRequestDetach = this._onDidRequestDetach.event;
	private readonly _onProcessDidChangeHasChildProcesses = new Emitter<{ id: number, event: boolean }>();
	readonly onProcessDidChangeHasChildProcesses = this._onProcessDidChangeHasChildProcesses.event;

	constructor(
		private rawURITransformerFactory: (remoteAuthority: string) => IRawURITransformer,
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
		private synchingTasks: Promise<Map<string, TaskStatus>>
	) {
		this._resolveVariablesRequestStore = new RequestStore(undefined, logService);
		this._resolveVariablesRequestStore.onCreateRequest(this._onPtyHostRequestResolveVariables.fire, this._onPtyHostRequestResolveVariables);

		this._detachInstanceRequestStore = new RequestStore(undefined, this.logService);
		this._detachInstanceRequestStore.onCreateRequest(this._onDidRequestDetach.fire, this._onDidRequestDetach);
	}

	private createTerminalProcess(
		initialCwd: string,
		workspaceId: string,
		workspaceName: string,
		shouldPersistTerminal: boolean,
		openOptions?: OpenSupervisorTerminalProcessOptions
	): SupervisorTerminalProcess {
		const terminalProcess = new SupervisorTerminalProcess(
			this.terminalIdSeq++,
			initialCwd,
			workspaceId,
			workspaceName,
			shouldPersistTerminal,
			this.logService,
			openOptions
		);
		this.terminalProcesses.set(terminalProcess.id, terminalProcess);
		terminalProcess.add({
			dispose: () => {
				this.terminalProcesses.delete(terminalProcess.id);
			}
		});
		terminalProcess.onProcessData(event => this._onProcessData.fire({ id: terminalProcess.id, event }));
		terminalProcess.onProcessExit(event => this._onProcessExit.fire({ id: terminalProcess.id, event }));
		terminalProcess.onProcessReady(event => this._onProcessReady.fire({ id: terminalProcess.id, event }));
		terminalProcess.onProcessTitleChanged(event => this._onProcessTitleChanged.fire({ id: terminalProcess.id, event }));
		terminalProcess.onProcessReplay(event => this._onProcessReplay.fire({ id: terminalProcess.id, event }));
		terminalProcess.onDidChangeHasChildProcesses(event => this._onProcessDidChangeHasChildProcesses.fire({ id: terminalProcess.id, event }));
		return terminalProcess;
	}
	private attachTerminalProcess(terminalProcess: SupervisorTerminalProcess): void {
		const alias = terminalProcess.alias;
		if (!alias) {
			return;
		}
		this.aliasToId.set(alias, terminalProcess.id);
		terminalProcess.add({ dispose: () => this.aliasToId.delete(alias) });
	}
	async call(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken | undefined): Promise<any> {
		if (command === '$createProcess') {
			return this.createProcess(ctx, arg);
		}
		if (command === '$requestDetachInstance') {
			const [workspaceId, instanceId]: [string, number] = arg;
			return this._detachInstanceRequestStore.createRequest({ workspaceId, instanceId });
		}
		if (command === '$acceptDetachInstanceReply') {
			const [requestId, persistentProcessId]: [number, number] = arg;
			let processDetails: IProcessDetails | undefined = undefined;
			const terminal = this.terminalProcesses.get(persistentProcessId);
			if (terminal) {
				processDetails = this._buildProcessDetails(terminal);
			}
			this._detachInstanceRequestStore.acceptReply(requestId, processDetails);
			return;
		}
		if (command === '$attachToProcess') {
			return;
		}
		if (command === '$reduceConnectionGraceTime') {
			return;
		}
		if (command === '$getEnvironment') {
			return { ...process.env };
		}
		if (command === '$getDefaultSystemShell') {
			return process.env['SHELL'] || '/bin/bash';
		}
		if (command === '$getProfiles') {
			const [workspaceId, profiles, defaultProfile, includeDetectedProfiles]: [string, unknown, unknown, boolean] = arg;
			return detectAvailableProfiles(profiles, defaultProfile, includeDetectedProfiles, this.configurationService, process.env, undefined, this.logService, this._resolveVariables.bind(this, workspaceId));
		}
		if (command === '$acceptPtyHostResolvedVariables') {
			const [id, resolved]: [number, string[]] = arg;
			return this.acceptPtyHostResolvedVariables(id, resolved);
		}
		if (command === '$getWslPath') {
			const [original]: [string] = arg;
			return original;
		}
		if (command === '$listProcesses') {
			try {
				const state = await this.sync();
				const result: IRemoteTerminalAttachTarget[] = [...state.terminals.values()];
				return result;
			} catch (e) {
				this.logService.error('code server: failed to list remote terminals:', e);
				return [];
			}
		}
		if (command === '$start') {
			const [id]: [number] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				return <ITerminalLaunchError>{
					message: 'terminal not found'
				};
			}
			const result = await terminalProcess.start();
			this.attachTerminalProcess(terminalProcess);
			return result;
		}
		if (command === '$input') {
			const [id, data]: [number, string] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.input(data);
		}
		if (command === '$processBinary') {
			const [id, data]: [number, string] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.processBinary(data);
		}
		if (command === '$acknowledgeDataEvent') {
			const [id, charCount]: [number, number] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.acknowledgeDataEvent(charCount);
		}
		if (command === '$shutdown') {
			const [id, immediate]: [number, boolean] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.shutdown(immediate);
		}
		if (command === '$resize') {
			const [id, cols, rows]: [number, number, number] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.resize(cols, rows);
		}
		if (command === '$getInitialCwd') {
			const [id]: [number] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.getInitialCwd();
		}
		if (command === '$getCwd') {
			const [id]: [number] = arg;
			const terminalProcess = this.terminalProcesses.get(id);
			if (!terminalProcess) {
				throw new Error('terminal not found');
			}
			return terminalProcess.getCwd();
		}
		/*if (command === '$sendCommandResult') {
			const [reqId, isError, payload]: [number, boolean, any] = arg;
			return;
		}
		if (command === '$orphanQuestionReply') {
			const [id]: [number] = arg;
			return;
		}*/
		if (command === '$setTerminalLayoutInfo') {
			const args: ISetTerminalLayoutInfoArgs = arg;
			this.layoutInfo.set(args.workspaceId, args.tabs);
			return;
		}
		if (command === '$getTerminalLayoutInfo') {
			try {
				const result = await this.getTerminalLayoutInfo(arg as IGetTerminalLayoutInfoArgs);
				return result;
			} catch (e) {
				this.logService.error('code server: failed to get terminal layout info:', e);
				return [];
			}
		}
		if (command === '$updateTitle') {
			const [id, title]: [number, string] = arg;
			this.terminalProcesses.get(id)?.setTitle(title);
			return;
		}
		if (command === '$updateIcon') {
			const [id, icon, color]: [number, TerminalIcon, string] = arg;
			this.terminalProcesses.get(id)?.setIcon(icon, color);
			return;
		}
		this.logService.error('Unknown command: RemoteTerminalChannel.' + command);
		throw new Error('Unknown command: RemoteTerminalChannel.' + command);
	}

	listen(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
		if (event === '$onPtyHostExitEvent') {
			return Event.None;
		}
		if (event === '$onPtyHostStartEvent') {
			return Event.None;
		}
		if (event === '$onPtyHostUnresponsiveEvent') {
			return Event.None;
		}
		if (event === '$onPtyHostResponsiveEvent') {
			return Event.None;
		}
		if (event === '$onPtyHostRequestResolveVariablesEvent') {
			return this._onPtyHostRequestResolveVariables.event;
		}
		if (event === '$onProcessDataEvent') {
			return this._onProcessData.event;
		}
		if (event === '$onProcessExitEvent') {
			return this._onProcessExit.event;
		}
		if (event === '$onProcessReadyEvent') {
			return this._onProcessReady.event;
		}
		if (event === '$onProcessReplayEvent') {
			const seen = new Set<number>();
			return Event.filter(this._onProcessReplay.event, e => {
				if (seen.has(e.id)) {
					return false;
				}
				seen.add(e.id);
				return true;
			});
		}
		if (event === '$onProcessTitleChangedEvent') {
			return this._onProcessTitleChanged.event;
		}
		if (event === '$onProcessShellTypeChangedEvent') {
			return Event.None;
		}
		if (event === '$onProcessOverrideDimensionsEvent') {
			return Event.None;
		}
		if (event === '$onProcessResolvedShellLaunchConfigEvent') {
			return Event.None;
		}
		if (event === '$onProcessOrphanQuestion') {
			return Event.None;
		}
		if (event === '$onProcessDidChangeHasChildProcesses') {
			return this._onProcessDidChangeHasChildProcesses.event;
		}
		if (event === '$onExecuteCommand') {
			return Event.None;
		}
		if (event === '$onDidRequestDetach') {
			return this._onDidRequestDetach.event;
		}
		this.logService.error('Unknown event: RemoteTerminalChannel.' + event);
		throw new Error('Unknown event: RemoteTerminalChannel.' + event);
	}

	private _resolveVariables(workspaceId: string, text: string[]): Promise<string[]> {
		return this._resolveVariablesRequestStore.createRequest({ workspaceId, originalText: text });
	}
	async acceptPtyHostResolvedVariables(requestId: number, resolved: string[]) {
		this._resolveVariablesRequestStore.acceptReply(requestId, resolved);
	}

	private async createProcess(ctx: RemoteAgentConnectionContext, arg: any): Promise<ICreateTerminalProcessResult> {
		const uriTranformer = new URITransformer(this.rawURITransformerFactory(ctx.remoteAuthority));
		const args = transformIncomingURIs(arg as ICreateTerminalProcessArguments, uriTranformer);
		const shellLaunchConfigDto = args.shellLaunchConfig;
		// see  $spawnExtHostProcess in src/vs/workbench/api/node/extHostTerminalService.ts for a reference implementation
		const shellLaunchConfig: IShellLaunchConfig = {
			name: shellLaunchConfigDto.name,
			executable: shellLaunchConfigDto.executable,
			args: shellLaunchConfigDto.args,
			cwd: typeof shellLaunchConfigDto.cwd === 'string' ? shellLaunchConfigDto.cwd : URI.revive(shellLaunchConfigDto.cwd),
			env: shellLaunchConfigDto.env
		};

		let lastActiveWorkspace: IWorkspaceFolder | undefined;
		if (args.activeWorkspaceFolder) {
			lastActiveWorkspace = toWorkspaceFolder(args.activeWorkspaceFolder);
		}

		const procesEnv = { ...process.env, ...args.resolverEnv } as platform.IProcessEnvironment;
		const configurationResolverService = new RemoteTerminalVariableResolverService(
			args.workspaceFolders.map(toWorkspaceFolder),
			args.resolvedVariables,
			args.activeFileResource ? URI.revive(args.activeFileResource) : undefined,
			procesEnv
		);
		const variableResolver = terminalEnvironment.createVariableResolver(lastActiveWorkspace, procesEnv, configurationResolverService);

		// Merge in shell and args from settings
		if (!shellLaunchConfig.executable) {
			shellLaunchConfig.executable = terminalEnvironment.getDefaultShell(
				key => args.configuration[key],
				getSystemShellSync(platform.OS, process.env as platform.IProcessEnvironment),
				process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432'),
				process.env.windir,
				variableResolver,
				this.logService,
				false
			);
			shellLaunchConfig.args = terminalEnvironment.getDefaultShellArgs(
				key => args.configuration[key],
				false,
				variableResolver,
				this.logService
			);
		} else if (variableResolver) {
			shellLaunchConfig.executable = variableResolver(shellLaunchConfig.executable);
			if (shellLaunchConfig.args) {
				if (Array.isArray(shellLaunchConfig.args)) {
					const resolvedArgs: string[] = [];
					for (const arg of shellLaunchConfig.args) {
						resolvedArgs.push(variableResolver(arg));
					}
					shellLaunchConfig.args = resolvedArgs;
				} else {
					shellLaunchConfig.args = variableResolver(shellLaunchConfig.args);
				}
			}
		}

		// Get the initial cwd
		const initialCwd = terminalEnvironment.getCwd(
			shellLaunchConfig,
			os.homedir(),
			variableResolver,
			lastActiveWorkspace?.uri,
			args.configuration['terminal.integrated.cwd'], this.logService
		);
		shellLaunchConfig.cwd = initialCwd;

		const envFromConfig = args.configuration['terminal.integrated.env.linux'];
		const baseEnv = procesEnv;
		const env = terminalEnvironment.createTerminalEnvironment(
			shellLaunchConfig,
			envFromConfig,
			variableResolver,
			product.version,
			args.configuration['terminal.integrated.detectLocale'] || 'auto',
			baseEnv
		);

		// Apply extension environment variable collections to the environment
		if (!shellLaunchConfig.strictEnv) {
			const collection = new Map<string, IEnvironmentVariableCollection>();
			for (const [name, serialized] of args.envVariableCollections) {
				collection.set(name, {
					map: deserializeEnvironmentVariableCollection(serialized)
				});
			}
			const mergedCollection = new MergedEnvironmentVariableCollection(collection);
			mergedCollection.applyToProcessEnvironment(env, variableResolver);
		}

		const terminalProcess = this.createTerminalProcess(
			initialCwd,
			args.workspaceId,
			args.workspaceName,
			args.shouldPersistTerminal,
			{
				shell: shellLaunchConfig.executable!,
				shellArgs: typeof shellLaunchConfig.args === 'string' ? [shellLaunchConfig.args] : shellLaunchConfig.args || [],
				cols: args.cols,
				rows: args.rows,
				env
			});
		const result: ICreateTerminalProcessResult = {
			persistentTerminalId: terminalProcess.id,
			resolvedShellLaunchConfig: shellLaunchConfig
		};
		return transformOutgoingURIs(result, uriTranformer);
	}

	private async getTerminalLayoutInfo(arg: IGetTerminalLayoutInfoArgs): Promise<ITerminalsLayoutInfo> {
		const { tasks, terminals: targets } = await this.sync(arg);
		const result: ITerminalsLayoutInfo = { tabs: [] };
		if (this.layoutInfo.has(arg.workspaceId)) {
			// restoring layout
			for (const tab of this.layoutInfo.get(arg.workspaceId)!) {
				result.tabs.push({
					...tab,
					terminals: tab.terminals.map(terminal => {
						const target = targets.get(terminal.terminal) || null;
						return {
							...terminal,
							terminal: target
						};
					})
				});
			}
		} else {
			// initial layout
			type Tab = IRawTerminalTabLayoutInfo<IRemoteTerminalAttachTarget | null>;
			let currentTab: Tab | undefined;
			let currentTerminal: IRemoteTerminalAttachTarget | undefined;
			const layoutTerminal = (terminal: IRemoteTerminalAttachTarget, mode: TerminalOpenMode = defaultOpenMode) => {
				if (!currentTab) {
					currentTab = {
						isActive: false,
						activePersistentProcessId: terminal.id,
						terminals: [{ relativeSize: 1, terminal }]
					};
					result.tabs.push(currentTab);
				} else if (mode === 'tab-after' || mode === 'tab-before') {
					const tab: Tab = {
						isActive: false,
						activePersistentProcessId: terminal.id,
						terminals: [{ relativeSize: 1, terminal }]
					};
					const currentIndex = result.tabs.indexOf(currentTab);
					const direction = mode === 'tab-after' ? 1 : -1;
					result.tabs.splice(currentIndex + direction, 0, tab);
					currentTab = tab;
				} else {
					currentTab.activePersistentProcessId = terminal.id;
					let currentIndex = -1;
					const relativeSize = 1 / (currentTab.terminals.length + 1);
					currentTab.terminals.forEach((info, index) => {
						info.relativeSize = relativeSize;
						if (info.terminal === currentTerminal) {
							currentIndex = index;
						}
					});
					const direction = (mode === 'split-right' || mode === 'split-bottom') ? 1 : -1;
					currentTab.terminals.splice(currentIndex + direction, 0, { relativeSize, terminal });
				}
				currentTerminal = terminal;
			};
			for (const [alias, status] of tasks) {
				const id = this.aliasToId.get(alias);
				if (typeof id !== 'number') {
					continue;
				}
				const terminal = targets.get(id);
				if (terminal) {
					targets.delete(id);
					layoutTerminal(terminal, asTerminalOpenMode(status.getPresentation()?.getOpenMode()));
				}
			}
			for (const id of targets.keys()) {
				const terminal = targets.get(id);
				if (terminal) {
					layoutTerminal(terminal);
				}
			}
			if (currentTab) {
				currentTab.isActive = true;
			}
		}

		return result;
	}

	private async sync(arg?: IGetTerminalLayoutInfoArgs): Promise<{
		tasks: Map<string, TaskStatus>,
		terminals: Map<number, IRemoteTerminalAttachTarget>
	}> {
		const tasks = await this.synchingTasks;
		try {
			const response = await util.promisify(terminalServiceClient.list.bind(terminalServiceClient, new ListTerminalsRequest(), supervisorMetadata, {
				deadline: Date.now() + supervisorDeadlines.long
			}))();
			for (const terminal of response.getTerminalsList()) {
				const alias = terminal.getAlias();
				const id = this.aliasToId.get(alias);
				const annotations = terminal.getAnnotationsMap();
				const workspaceId = annotations.get('workspaceId') || '';
				const workspaceName = annotations.get('workspaceName') || '';
				const shouldPersistTerminal = tasks.has(alias) || Boolean(annotations.get('shouldPersistTerminal'));
				if (id) {
					const terminalProcess = this.terminalProcesses.get(id);
					if (terminalProcess) {
						terminalProcess.syncState = terminal;
					}
				} else {
					const terminalProcess = this.createTerminalProcess(
						terminal.getInitialWorkdir(),
						workspaceId,
						workspaceName,
						shouldPersistTerminal
					);

					terminalProcess.syncState = terminal;
					this.attachTerminalProcess(terminalProcess);
				}
			}
		} catch (e) {
			console.error('code server: failed to sync terminals:', e);
		}
		const terminals = new Map<number, IRemoteTerminalAttachTarget>();
		for (const terminal of this.terminalProcesses.values()) {
			if (!arg || (
				arg.workspaceId === terminal.workspaceId || (terminal.alias && tasks.has(terminal.alias)))
			) {
				const details = this._buildProcessDetails(terminal);
				if (details) {
					terminals.set(terminal.id, details);
				}
			}
		}
		return { tasks, terminals };
	}

	private _buildProcessDetails(terminal: SupervisorTerminalProcess): IProcessDetails | undefined {
		if (!terminal.syncState) {
			return undefined;
		}

		let icon: TerminalIcon | undefined;
		try {
			const iconAnnotation = terminal.syncState.getAnnotationsMap().get('icon');
			if (iconAnnotation) {
				icon = JSON.parse(iconAnnotation);
			}
		} catch { }
		const color = terminal.syncState.getAnnotationsMap().get('color');

		return {
			id: terminal.id,
			title: terminal.syncState.getTitle(),
			titleSource: terminal.syncState.getTitleSource() === TerminalTitleSource.API ? TitleEventSource.Api : TitleEventSource.Process,
			pid: terminal.syncState.getPid(),
			workspaceId: terminal.workspaceId,
			workspaceName: terminal.workspaceName,
			cwd: terminal.syncState.getCurrentWorkdir(),
			isOrphan: true,
			icon,
			color
		};
	}

}
