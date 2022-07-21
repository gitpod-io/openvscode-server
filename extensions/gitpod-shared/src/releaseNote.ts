/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch, { Response } from 'node-fetch';
import * as vscode from 'vscode';
import { load } from 'js-yaml';
import { CacheHelper } from './common/cache';

const LAST_READ_RELEASE_NOTES_ID = 'gitpod.lastReadReleaseNotesId';

export function registerReleaseNotesView(context: vscode.ExtensionContext) {
	const cacheHelper = new CacheHelper(context);

	async function shouldShowReleaseNotes(lastReadId: string | undefined) {
		const releaseId = await getLastPublish(cacheHelper);
		console.log(`gitpod release notes lastReadId: ${lastReadId}, latestReleaseId: ${releaseId}`);
		return releaseId !== lastReadId;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('gitpod.showReleaseNotes', () => {
			ReleaseNotesPanel.createOrShow(context, cacheHelper);
		})
	);

	// sync between machines
	context.globalState.setKeysForSync([LAST_READ_RELEASE_NOTES_ID]);

	const lastReadId = context.globalState.get<string>(LAST_READ_RELEASE_NOTES_ID);
	shouldShowReleaseNotes(lastReadId).then(shouldShow => {
		if (shouldShow) {
			ReleaseNotesPanel.createOrShow(context, cacheHelper);
		}
	});
}

function getResponseCacheTime(resp: Response) {
	const v = resp.headers.get('Cache-Control');
	if (!v) {
		return undefined;
	}
	const t = /max-age=(\d+)/.exec(v);
	if (!t) {
		return undefined;
	}
	return Number(t[1]);
}

async function getLastPublish(cacheHelper: CacheHelper) {
	const url = `${websiteHost}/changelog/latest`;
	return cacheHelper.getOrRefresh(url, async () => {
		const resp = await fetch(url);
		if (!resp.ok) {
			throw new Error(`Getting latest releaseId failed: ${resp.statusText}`);
		}
		const { releaseId } = JSON.parse(await resp.text());
		return {
			value: releaseId as string,
			ttl: getResponseCacheTime(resp),
		};
	});

}

const websiteHost = 'https://www.gitpod.io';

class ReleaseNotesPanel {
	public static currentPanel: ReleaseNotesPanel | undefined;
	public static readonly viewType = 'gitpodReleaseNotes';
	private readonly panel: vscode.WebviewPanel;
	private lastReadId: string | undefined;
	private _disposables: vscode.Disposable[] = [];

	private async loadChangelog(releaseId: string) {
		const url = `${websiteHost}/changelog/raw-markdown?releaseId=${releaseId}`;
		const md = await this.cacheHelper.getOrRefresh(url, async () => {
			const resp = await fetch(url);
			if (!resp.ok) {
				throw new Error(`Getting raw markdown content failed: ${resp.statusText}`);
			}
			const md = await resp.text();
			return {
				value: md,
				ttl: getResponseCacheTime(resp),
			};
		});

		const parseInfo = (md: string) => {
			if (!md.startsWith('---')) {
				return;
			}
			const lines = md.split('\n');
			const end = lines.indexOf('---', 1);
			const content = lines.slice(1, end).join('\n');
			return load(content) as { title: string; date: string; image: string; alt: string; excerpt: string };
		};
		const info = parseInfo(md);

		const content = md
			.replace(/---.*?---/gms, '')
			.replace(/<script>.*?<\/script>/gms, '')
			.replace(/<Badge.*?text="(.*?)".*?\/>/gim, '`$1`')
			.replace(/<Contributors usernames="(.*?)" \/>/gim, (_, p1) => {
				const users = p1
					.split(',')
					.map((e: string) => `[${e}](https://github.com/${e})`);
				return `Contributors: ${users.join(', ')}`;
			})
			.replace(/<p>(.*?)<\/p>/gm, '$1')
			.replace(/^[\n]+/m, '');
		if (!info) {
			return content;
		}
		const releaseDate = Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(new Date(releaseId));
		return [
			`# ${info.title}`,
			`> Published on ${releaseDate}, see also https://www.gitpod.io/changelog`,
			`![${info.alt ?? 'image'}](https://www.gitpod.io/images/changelog/${info.image})`,
			content,
		].join('\n\n');
	}

	public async updateHtml(releaseId?: string) {
		if (!releaseId) {
			releaseId = await getLastPublish(this.cacheHelper);
		}
		const mdContent = await this.loadChangelog(releaseId);
		const html = await vscode.commands.executeCommand('markdown.api.render', mdContent) as string;
		this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Gitpod Release Notes</title>
	<style>
		${DEFAULT_MARKDOWN_STYLES}
	</style>
</head>
	<body>
		${html}
	</body>
</html>`;
		if (!this.lastReadId || releaseId > this.lastReadId) {
			await this.context.globalState.update(LAST_READ_RELEASE_NOTES_ID, releaseId);
			this.lastReadId = releaseId;
		}
	}

	public static createOrShow(context: vscode.ExtensionContext, cacheHelper: CacheHelper) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (ReleaseNotesPanel.currentPanel) {
			ReleaseNotesPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			ReleaseNotesPanel.viewType,
			'Gitpod Release Notes',
			column || vscode.ViewColumn.One,
			{ enableScripts: true },
		);

		ReleaseNotesPanel.currentPanel = new ReleaseNotesPanel(context, cacheHelper, panel);
	}

	public static revive(context: vscode.ExtensionContext, cacheHelper: CacheHelper, panel: vscode.WebviewPanel) {
		ReleaseNotesPanel.currentPanel = new ReleaseNotesPanel(context, cacheHelper, panel);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly cacheHelper: CacheHelper,
		panel: vscode.WebviewPanel
	) {
		this.lastReadId = this.context.globalState.get<string>(LAST_READ_RELEASE_NOTES_ID);
		this.panel = panel;

		this.updateHtml();

		this.panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this.panel.onDidChangeViewState(
			() => {
				if (this.panel.visible) {
					this.updateHtml();
				}
			},
			null,
			this._disposables
		);
	}

	public dispose() {
		ReleaseNotesPanel.currentPanel = undefined;
		this.panel.dispose();
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
}

// Align with https://github.com/gitpod-io/openvscode-server/blob/494f7eba3615344ee634e6bec0b20a1903e5881d/src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts#L14
export const DEFAULT_MARKDOWN_STYLES = `
body {
	padding: 10px 20px;
	line-height: 22px;
	max-width: 882px;
	margin: 0 auto;
}

body *:last-child {
	margin-bottom: 0;
}

img {
	max-width: 100%;
	max-height: 100%;
}

a {
	text-decoration: none;
}

a:hover {
	text-decoration: underline;
}

a:focus,
input:focus,
select:focus,
textarea:focus {
	outline: 1px solid -webkit-focus-ring-color;
	outline-offset: -1px;
}

hr {
	border: 0;
	height: 2px;
	border-bottom: 2px solid;
}

h1 {
	padding-bottom: 0.3em;
	line-height: 1.2;
	border-bottom-width: 1px;
	border-bottom-style: solid;
}

h1, h2, h3 {
	font-weight: normal;
}

table {
	border-collapse: collapse;
}

table > thead > tr > th {
	text-align: left;
	border-bottom: 1px solid;
}

table > thead > tr > th,
table > thead > tr > td,
table > tbody > tr > th,
table > tbody > tr > td {
	padding: 5px 10px;
}

table > tbody > tr + tr > td {
	border-top-width: 1px;
	border-top-style: solid;
}

blockquote {
	margin: 0 7px 0 5px;
	padding: 0 16px 0 10px;
	border-left-width: 5px;
	border-left-style: solid;
}

code {
	font-family: "SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace;
}

pre code {
	font-family: var(--vscode-editor-font-family);
	font-weight: var(--vscode-editor-font-weight);
	font-size: var(--vscode-editor-font-size);
	line-height: 1.5;
}

code > div {
	padding: 16px;
	border-radius: 3px;
	overflow: auto;
}

.monaco-tokenized-source {
	white-space: pre;
}

/** Theming */

.vscode-light code > div {
	background-color: rgba(220, 220, 220, 0.4);
}

.vscode-dark code > div {
	background-color: rgba(10, 10, 10, 0.4);
}

.vscode-high-contrast code > div {
	background-color: var(--vscode-textCodeBlock-background);
}

.vscode-high-contrast h1 {
	border-color: rgb(0, 0, 0);
}

.vscode-light table > thead > tr > th {
	border-color: rgba(0, 0, 0, 0.69);
}

.vscode-dark table > thead > tr > th {
	border-color: rgba(255, 255, 255, 0.69);
}

.vscode-light h1,
.vscode-light hr,
.vscode-light table > tbody > tr + tr > td {
	border-color: rgba(0, 0, 0, 0.18);
}

.vscode-dark h1,
.vscode-dark hr,
.vscode-dark table > tbody > tr + tr > td {
	border-color: rgba(255, 255, 255, 0.18);
}

`;
