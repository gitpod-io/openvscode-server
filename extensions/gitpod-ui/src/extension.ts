/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vs/vscode.d.ts'/>

import { AutoTunnelRequest } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb';
import { LocalAppClient } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb_service';
import { grpc } from '@improbable-eng/grpc-web';
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
	if (vscode.env.remoteName === undefined || context.extension.extensionKind !== vscode.ExtensionKind.UI) {
		return;
	}

	grpc.setDefaultTransport(NodeHttpTransport());
	const defaultApiPort = 63100; // TODO(ak) settings
	const client = new LocalAppClient('http://localhost:' + defaultApiPort);

	context.subscriptions.push(vscode.commands.registerCommand('gitpod-ui.api.autoTunnel', (instanceId: string, enabled: boolean) => {
		const request = new AutoTunnelRequest();
		request.setInstanceId(instanceId);
		request.setEnabled(enabled);
		client.autoTunnel(request, e => {
			if (e) {
				console.error('failed to disable auto tunneling', e);
			}
		});
	}));
}

export function deactivate() { }
