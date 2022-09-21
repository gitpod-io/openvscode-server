/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { GitpodExtensionContext, ExposedServedGitpodWorkspacePort, GitpodWorkspacePort, isExposedServedGitpodWorkspacePort, isExposedServedPort, PortInfo } from 'gitpod-shared';
import { PortsStatus } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { isUserOverrideSetting } from './experiments';

const PortCommands = <const>['tunnelNetwork', 'tunnelHost', 'makePublic', 'makePrivate', 'preview', 'openBrowser', 'retryAutoExpose', 'urlCopy', 'queryPortData'];

type PortCommand = typeof PortCommands[number];

export class GitpodPortViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'gitpod.portsView';

	private _view?: vscode.WebviewView;

	readonly portMap = new Map<number, GitpodWorkspacePort>();

	private readonly onDidExposeServedPortEmitter = new vscode.EventEmitter<ExposedServedGitpodWorkspacePort>();
	readonly onDidExposeServedPort = this.onDidExposeServedPortEmitter.event;


	private readonly onDidChangePortsEmitter = new vscode.EventEmitter<Map<number, GitpodWorkspacePort>>();
	readonly onDidChangePorts = this.onDidChangePortsEmitter.event;

	constructor(private readonly context: GitpodExtensionContext) { }

	// @ts-ignore
	resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken): void | Thenable<void> {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
		webviewView.onDidChangeVisibility(() => {
			if (!webviewView.visible) {
				return;
			}
			this.updateHtml();
		});
		this.onHtmlCommand();
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'public', 'codicon.css'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'public', 'portsview.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'public', 'portsview.js'));
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="X-UA-Compatible" content="IE=edge" />

	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${codiconsUri}" rel="stylesheet" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>Gitpod Port View</title>
</head>
<body></body>
<script nonce="${nonce}" src="${scriptUri}"></script>
</html>`;
	}

	private tunnelsMap = new Map<number, vscode.TunnelDescription>();
	updateTunnels(tunnelsMap: Map<number, vscode.TunnelDescription>): void {
		this.tunnelsMap = tunnelsMap;
		this.update();
	}

	private portStatus: PortsStatus.AsObject[] | undefined;
	updatePortsStatus(portsStatus: PortsStatus.AsObject[]): void {
		this.portStatus = portsStatus;
		this.update();
	}

	private updating = false;
	private update(): void {
		if (this.updating) { return; }
		this.updating = true;
		try {
			if (!this.portStatus) { return; }
			this.portStatus.forEach(e => {
				const localPort = e.localPort;
				const tunnel = this.tunnelsMap.get(localPort);
				let gitpodPort = this.portMap.get(localPort);
				const prevStatus = gitpodPort?.status;
				if (!gitpodPort) {
					gitpodPort = new GitpodWorkspacePort(localPort, e, tunnel);
					this.portMap.set(localPort, gitpodPort);
				} else {
					gitpodPort.update(e, tunnel);
				}
				if (isExposedServedGitpodWorkspacePort(gitpodPort) && !isExposedServedPort(prevStatus)) {
					this.onDidExposeServedPortEmitter.fire(gitpodPort);
				}
			});
			this.onDidChangePortsEmitter.fire(this.portMap);
			this.updateHtml();
		} finally {
			this.updating = false;
		}
	}

	private updateHtml(): void {
		const ports = Array.from(this.portMap.values()).map(e => e.toSvelteObject());
		this._view?.webview.postMessage({ command: 'updatePorts', ports });
	}

	private onHtmlCommand() {
		this._view?.webview.onDidReceiveMessage(async (message: { command: PortCommand; port: { info: PortInfo; status: PortsStatus.AsObject } }) => {
			if (message.command === 'queryPortData') {
				this.updateHtml();
				return;
			}
			const port = this.portMap.get(message.port.status.localPort);
			if (!port) { return; }
			if (message.command === 'urlCopy' && port.status.exposed) {
				await vscode.env.clipboard.writeText(port.status.exposed.url);
				this.context.fireAnalyticsEvent({
					eventName: 'vscode_execute_command_gitpod_ports',
					properties: { action: 'urlCopy', isWebview: true, userOverride: String(isUserOverrideSetting('gitpod.experimental.portsView.enabled')) }
				});
				return;
			}
			vscode.commands.executeCommand('gitpod.ports.' + message.command, { port, isWebview: true });
		});
	}
}

function getNonce() {
	let text = '';
	const possible =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
