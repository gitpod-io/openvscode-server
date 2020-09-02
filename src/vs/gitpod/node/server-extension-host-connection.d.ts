/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as rpc from 'vscode-jsonrpc';

export interface ValidateExtensionsParam {
	extensions: {
		id: string
		version?: string
	}[]
	links: string[]
}

export interface ValidateExtensionsResult {
	extensions: string[]
	links: string[]
	missingMachined: string[]
	uninstalled: string[]
}

export type setActiveCliIpcHookMethod = 'setActiveCliIpcHook';
export type validateExtensionsMethod = 'validateExtensions';
export type installExtensionFromConfigMethod = 'installExtensionFromConfig';
export type onDidInstallExtensionMethod = 'onDidInstallExtension';
export type onDidUninstallExtensionMethod = 'onDidUninstallExtension';
export interface ServerExtensionHostConnection {
	sendNotification(method: setActiveCliIpcHookMethod, cliIpcHook: string | undefined): void;
	onNotification(method: setActiveCliIpcHookMethod, handler: (cliIpcHook: string | undefined) => void): void;
	sendRequest(method: validateExtensionsMethod, param: ValidateExtensionsParam, token: rpc.CancellationToken): Promise<ValidateExtensionsResult>;
	onRequest(method: validateExtensionsMethod, handler: (param: ValidateExtensionsParam, token: rpc.CancellationToken) => Promise<ValidateExtensionsResult>): void
	sendRequest(method: installExtensionFromConfigMethod, id: string): Promise<void>;
	onRequest(method: installExtensionFromConfigMethod, handler: (id: string) => Promise<void>): void
	sendNotification(method: onDidInstallExtensionMethod): void;
	onNotification(method: onDidInstallExtensionMethod, handler: () => void): void;
	sendNotification(method: onDidUninstallExtensionMethod): void;
	onNotification(method: onDidUninstallExtensionMethod, handler: () => void): void;

	listen(): void;
	dispose(): void;
	onClose: rpc.Event<void>;
	onDispose: rpc.Event<void>;
}
