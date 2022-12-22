/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { exists } from './common/utils';
import { GitpodYml } from './gitpodYaml';

export class GitpodYamlCodelensProvider implements vscode.CodeLensProvider {

	private dockerFileUri: vscode.Uri | undefined;

	constructor() {
	}

	public setValidDockerFile(uri: vscode.Uri | undefined) {
		this.dockerFileUri = uri;
	}

	public provideCodeLenses(document: vscode.TextDocument, _tkn: vscode.CancellationToken): vscode.CodeLens[] {
		if (!this.dockerFileUri || document.fileName.endsWith('Dockerfile') && document.uri.fsPath !== this.dockerFileUri.fsPath) {
			return [];
		}

		const text = document.getText();
		const match = /(.+)/.exec(text);
		if (match) {
			const line = document.lineAt(document.positionAt(match.index).line);
			return [
				new vscode.CodeLens(line.range, {
					title: 'Build',
					tooltip: 'Build',
					command: 'gitpod.gitpodyml.build',
				}),
				new vscode.CodeLens(line.range, {
					title: 'Learn',
					tooltip: 'Learn',
					command: 'gitpod.gitpodyml.learn',
				}),
				new vscode.CodeLens(line.range, {
					title: 'Feedback',
					tooltip: 'Feedback',
					command: 'gitpod.gitpodyml.feedback',
				}),
			];
		}
		return [];
	}

	public resolveCodeLens(codeLens: vscode.CodeLens, _tkn: vscode.CancellationToken) {
		return codeLens;
	}
}

export class GitpodCodelens extends vscode.Disposable {
	private disposables: vscode.Disposable[] = [];

	private codelensProvider = new GitpodYamlCodelensProvider();

	private terminal: vscode.Terminal | undefined;

	constructor(private gitpodYaml: GitpodYml) {
		super(() => { });

		this.initialize();

		this.disposables.push(gitpodYaml.onDidChangeGitpodYml(() => {
			this.updateDockerFile();
		}));
	}

	async initialize(): Promise<void> {
		if (!(await exists('/ide/bin/run-gp-cli/gp-run'))) {
			return;
		}

		vscode.commands.executeCommand('setContext', 'gitpod.run-gp.enabled', true);

		await this.updateDockerFile();

		this.disposables.push(vscode.languages.registerCodeLensProvider({ pattern: '**/.gitpod.yml' }, this.codelensProvider));
		this.disposables.push(vscode.languages.registerCodeLensProvider({ pattern: '**/{*.Dockerfile,Dockerfile}' }, this.codelensProvider));

		this.disposables.push(vscode.commands.registerCommand('gitpod.gitpodyml.build', () => {
			if (!this.terminal || this.terminal.exitStatus) {
				this.terminal = vscode.window.createTerminal('gp-run');
			}
			this.terminal.sendText('gp-run --all-commands=false', true);
			this.terminal.show();
		}));
		this.disposables.push(vscode.commands.registerCommand('gitpod.gitpodyml.learn', () => {
			const url = 'https://www.gitpod.io/docs/references/gitpod-yml';
			return vscode.env.openExternal(vscode.Uri.parse(url));
		}));
		this.disposables.push(vscode.commands.registerCommand('gitpod.gitpodyml.feedback', () => {
			const url = 'https://github.com/gitpod-io/gitpod/issues/7671';
			return vscode.env.openExternal(vscode.Uri.parse(url));
		}));
	}

	private async updateDockerFile() {
		const yaml = await this.gitpodYaml.getYaml();
		const dockerfile = yaml.document.getIn(['image', 'file']);
		if (dockerfile) {
			const dir = path.posix.dirname(this.gitpodYaml.uri.path);
			this.codelensProvider.setValidDockerFile(this.gitpodYaml.uri.with({ path: path.join(dir, dockerfile) }));
		} else {
			this.codelensProvider.setValidDockerFile(undefined);
		}
	}

	override dispose() {
		this.disposables.forEach(d => d.dispose());
	}
}
