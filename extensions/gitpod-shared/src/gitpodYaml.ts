/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitpodPluginModel } from './gitpod-plugin-model';

export class GitpodYml extends vscode.Disposable {
	private disposables: vscode.Disposable[] = [];

	private readonly _onDidChangeGitpodYml = new vscode.EventEmitter<void>();
	public readonly onDidChangeGitpodYml = this._onDidChangeGitpodYml.event;

	constructor(public readonly uri: vscode.Uri) {
		super(() => { });

		this.disposables.push(vscode.workspace.onDidSaveTextDocument(e => {
			if (e.uri.fsPath === this.uri.fsPath) {
				this.refresh();
			}
		}));
	}

	private refresh() {
		this._onDidChangeGitpodYml.fire();
	}

	async getRawContent() {
		try {
			const document = await vscode.workspace.openTextDocument(this.uri);
			return document.getText();
		} catch {
			return '';
		}
	}

	async getYaml() {
		return new GitpodPluginModel(await this.getRawContent());
	}

	async writeContent(content: string) {
		let document: vscode.TextDocument | undefined;
		try {
			document = await vscode.workspace.openTextDocument(this.uri);
		} catch {
		}

		const edit = new vscode.WorkspaceEdit();
		if (document) {
			edit.replace(this.uri, document.validateRange(new vscode.Range(
				document.positionAt(0),
				document.positionAt(content.length)
			)), content);
		} else {
			edit.createFile(this.uri, { overwrite: true });
			edit.insert(this.uri, new vscode.Position(0, 0), content);
		}
		await vscode.workspace.applyEdit(edit);
	}

	override dispose() {
		this._onDidChangeGitpodYml.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
