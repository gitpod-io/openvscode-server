/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { exists } from './common/utils';
import { GitpodYml } from './gitpodYaml';

const gitpodYmlActions = {
	build: {
		command: 'gitpod.gitpodyml.build',
		title: 'Build',
		description: 'Build Gitpod Configuration',
		shellCommand: 'gp-run --all-commands=false'
	},
	run: {
		command: 'gitpod.gitpodyml.run',
		title: 'Test',
		description: 'Test Gitpod Configuration',
		shellCommand: 'gp-run'
	},
	feedback: {
		command: 'gitpod.gitpodyml.feedback',
		title: 'Feedback',
		description: 'Leave feedback on the Gitpod configuration experience',
	},
	learn: {
		command: 'gitpod.gitpodyml.learn',
		title: 'Learn',
		description: 'Learn more about configuring a Gitpod workspace'
	}
};

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
					title: gitpodYmlActions.build.title,
					tooltip: gitpodYmlActions.build.description,
					command: gitpodYmlActions.build.command,
				}),
				new vscode.CodeLens(line.range, {
					title: gitpodYmlActions.run.title,
					tooltip: gitpodYmlActions.run.description,
					command: gitpodYmlActions.run.command,
				}),
				new vscode.CodeLens(line.range, {
					title: gitpodYmlActions.learn.title,
					tooltip: gitpodYmlActions.learn.description,
					command: gitpodYmlActions.learn.command,
				}),
				new vscode.CodeLens(line.range, {
					title: gitpodYmlActions.feedback.title,
					tooltip: gitpodYmlActions.feedback.description,
					command: gitpodYmlActions.feedback.command,
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

	private async initiateUserTask(options: typeof gitpodYmlActions.build) {
		const allTasksExecutions = vscode.tasks.taskExecutions;
		const isTaskRunning = allTasksExecutions.find(task => task.task.source === options.command);
		if (isTaskRunning) {
			const restart = 'Restart task';
			const cancel = 'Terminate task';
			const action = await vscode.window.showWarningMessage(`The ${options.description} Task is already running`, { modal: true }, restart, cancel);

			if (action) {
				isTaskRunning.terminate();
			}

			if (action === cancel) {
				return;
			}
		}

		await vscode.tasks.executeTask(
			new vscode.Task(
				{ type: 'shell' },
				vscode.TaskScope.Workspace,
				options.description,
				options.command,
				new vscode.ShellExecution(options.shellCommand)));
	}

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

		await vscode.commands.executeCommand('setContext', 'gitpod.run-gp.enabled', true);

		await this.updateDockerFile();

		this.disposables.push(vscode.languages.registerCodeLensProvider({ pattern: '**/.gitpod.yml' }, this.codelensProvider));
		this.disposables.push(vscode.languages.registerCodeLensProvider({ pattern: '**/{*.Dockerfile,Dockerfile}' }, this.codelensProvider));

		this.disposables.push(vscode.commands.registerCommand(gitpodYmlActions.build.command, async () => {
			await this.initiateUserTask(gitpodYmlActions.build);
		}));
		this.disposables.push(vscode.commands.registerCommand(gitpodYmlActions.run.command, async () => {
			await this.initiateUserTask(gitpodYmlActions.run);
		}));
		this.disposables.push(vscode.commands.registerCommand(gitpodYmlActions.learn.command, () => {
			const url = 'https://www.gitpod.io/docs/references/gitpod-yml';
			return vscode.env.openExternal(vscode.Uri.parse(url));
		}));
		this.disposables.push(vscode.commands.registerCommand(gitpodYmlActions.feedback.command, () => {
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
