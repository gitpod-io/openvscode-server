/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as grpc from '@grpc/grpc-js';
import * as util from 'util';
import { GitpodExtensionContext, GitpodWorkspacePort } from 'gitpod-shared';
import { PortsStatus, PortsStatusRequest, PortsStatusResponse } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { RetryAutoExposeRequest, TunnelVisiblity } from '@gitpod/supervisor-api-grpc/lib/port_pb';
import { isGRPCErrorStatus } from 'gitpod-shared/src/common/utils';

export async function getSupervisorPorts(context: GitpodExtensionContext) {
	let supervisorPortList: PortsStatus.AsObject[] = [];
	try {
		supervisorPortList = await new Promise<PortsStatus.AsObject[]>((resolve, reject) => {
			const req = new PortsStatusRequest();
			const evts = context.supervisor.status.portsStatus(req, context.supervisor.metadata);
			evts.on('error', reject);
			evts.on('data', (resp: PortsStatusResponse) => resolve(resp.getPortsList().map(p => p.toObject())));
		});
	} catch (e) {
		context.logger.error('Could not fetch ports info from supervisor', e);
	}
	return supervisorPortList;
}

export function observePortsStatus(context: GitpodExtensionContext): [vscode.EventEmitter<PortsStatus.AsObject[]>, { dispose: () => any }] {
	const onPortUpdate = new vscode.EventEmitter<PortsStatus.AsObject[]>();
	let run = true;
	let stopUpdates: Function | undefined;
	(async () => {
		while (run) {
			try {
				const req = new PortsStatusRequest();
				req.setObserve(true);
				const evts = context.supervisor.status.portsStatus(req, context.supervisor.metadata);
				stopUpdates = evts.cancel.bind(evts);

				await new Promise((resolve, reject) => {
					evts.on('end', resolve);
					evts.on('error', reject);
					evts.on('data', (resp: PortsStatusResponse) => onPortUpdate.fire(resp.getPortsList().map(p => p.toObject())));
				});
			} catch (err) {
				if (!isGRPCErrorStatus(err, grpc.status.CANCELLED)) {
					context.logger.error('cannot maintain connection to supervisor', err);
					console.error('cannot maintain connection to supervisor', err);
				}
			} finally {
				stopUpdates = undefined;
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	})();

	const toDispose = {
		dispose() {
			onPortUpdate.dispose();
			run = false;
			if (stopUpdates) {
				stopUpdates();
			}
		}
	};
	return [onPortUpdate, toDispose];
}

export async function tunnelPorts(supervisorPortList: PortsStatus.AsObject[]) {
	for (const port of supervisorPortList) {
		if (port.served) {
			await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port.localPort}`));
		}
	}
}

interface PortItem { port: GitpodWorkspacePort }

export function registerPortCommands(context: GitpodExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.makePrivate', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'private' }
		});
		context?.setPortVisibility(port.status.localPort, 'private');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.makePublic', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'public' }
		});
		context?.setPortVisibility(port.status.localPort, 'public');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.tunnelNetwork', ({ port }: PortItem) => {
		context?.setTunnelVisibility(port.portNumber, port.portNumber, TunnelVisiblity.NETWORK);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.tunnelHost', async ({ port }: PortItem) =>
		context?.setTunnelVisibility(port.portNumber, port.portNumber, TunnelVisiblity.HOST)
	));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.preview', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'preview' }
		});
		vscode.commands.executeCommand('simpleBrowser.api.open', port.externalUrl.toString(), {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: true
		});
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.openBrowser', ({ port }: PortItem) => {
		context.fireAnalyticsEvent({
			eventName: 'vscode_execute_command_gitpod_ports',
			properties: { action: 'openBrowser' }
		});
		vscode.env.openExternal(vscode.Uri.parse(port.localUrl));
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.ports.retryAutoExpose', async ({ port }: PortItem) => {
		const request = new RetryAutoExposeRequest();
		request.setPort(port.portNumber);
		await util.promisify(context.supervisor.port.retryAutoExpose.bind(context.supervisor.port, request, context.supervisor.metadata, {
			deadline: Date.now() + context.supervisor.deadlines.normal
		}))();
	}));
}
