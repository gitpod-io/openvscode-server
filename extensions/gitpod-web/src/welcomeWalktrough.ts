/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitpodExtensionContext } from 'gitpod-shared';

export const WELCOME_WALKTROUGH_KEY = 'walkthrough.version';

const currentVersion: number = 0.1;

export function registerWelcomeWalkthroughContribution(context: GitpodExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.welcome.createTerminalAndRunDockerCommand', () => {
		const terminal = vscode.window.createTerminal('Welcome');
		terminal.show();
		terminal.sendText('docker run hello-world');
	}));

	// vscode will show the walktrough automatically but only if the extension is installed
	// while the workbench session is visible, gitpod-web extension is bundled as a
	// built-in extension so we need to do it ourselves
	const lastVersionShown = context.globalState.get<number>(WELCOME_WALKTROUGH_KEY);
	if (lastVersionShown === undefined && vscode.window.visibleTextEditors.length === 0) {
		context.globalState.update(WELCOME_WALKTROUGH_KEY, currentVersion);
		vscode.commands.executeCommand('workbench.action.openWalkthrough', 'gitpod.gitpod-web#gitpod-getstarted', false);
	}
}
