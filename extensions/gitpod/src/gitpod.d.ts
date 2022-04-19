/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { GitpodExtensionContext } from './features';
export { GitpodExtensionContext };
export interface GitpodExtension {
	newContext(context: vscode.ExtensionContext): GitpodExtensionContext;
}

import type { GitpodPluginModel } from './gitpod-plugin-model';
export { GitpodPluginModel };

import type * as status from '@gitpod/supervisor-api-grpc/lib/status_pb';
import type * as port from '@gitpod/supervisor-api-grpc/lib/port_pb';
import type * as terminal from '@gitpod/supervisor-api-grpc/lib/terminal_pb';
export {
	status, port, terminal
};
