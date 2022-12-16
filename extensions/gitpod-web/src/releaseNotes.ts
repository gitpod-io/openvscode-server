/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch, { Response } from 'node-fetch';
import * as vscode from 'vscode';
import { load } from 'js-yaml';
import { CacheHelper } from './util/cache';
import { Disposable, disposeAll } from './util/dispose';

export class ReleaseNotes extends Disposable {
	public static readonly viewType = 'gitpodReleaseNotes';
	public static readonly websiteHost = 'https://www.gitpod.io';
	public static readonly RELEASE_NOTES_LAST_READ_KEY = 'gitpod.lastReadReleaseNotesId';

	private panel: vscode.WebviewPanel | undefined;
	private panelDisposables: vscode.Disposable[] = [];
	private lastReadId: string | undefined;
	private cacheHelper = new CacheHelper(this.context);

	constructor(
		private readonly context: vscode.ExtensionContext,
	) {
		super();

		this.lastReadId = this.context.globalState.get<string>(ReleaseNotes.RELEASE_NOTES_LAST_READ_KEY);

		this._register(vscode.commands.registerCommand('gitpod.showReleaseNotes', () => this.createOrShow()));

		this.showIfNewRelease(this.lastReadId);
	}

	private async getLastPublish() {
		const url = `${ReleaseNotes.websiteHost}/changelog/latest`;
		return this.cacheHelper.getOrRefresh(url, async () => {
			const resp = await fetch(url);
			if (!resp.ok) {
				throw new Error(`Getting latest releaseId failed: ${resp.statusText}`);
			}
			const { releaseId } = JSON.parse(await resp.text());
			return {
				value: releaseId as string,
				ttl: this.getResponseCacheTime(resp),
			};
		});
	}

	private getResponseCacheTime(resp: Response) {
		const cacheControlHeader = resp.headers.get('Cache-Control');
		if (!cacheControlHeader) {
			return undefined;
		}
		const match = /max-age=(\d+)/.exec(cacheControlHeader);
		if (!match) {
			return undefined;
		}
		return parseInt(match[1], 10);
	}

	private async loadChangelog(releaseId: string) {
		const url = `${ReleaseNotes.websiteHost}/changelog/raw-markdown?releaseId=${releaseId}`;
		const md = await this.cacheHelper.getOrRefresh(url, async () => {
			const resp = await fetch(url);
			if (!resp.ok) {
				throw new Error(`Getting raw markdown content failed: ${resp.statusText}`);
			}
			const md = await resp.text();
			return {
				value: md,
				ttl: this.getResponseCacheTime(resp),
			};
		});
		if (!md) {
			return;
		}

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
			.replace(/^---.*?---/gms, '')
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
			`![${info.alt ?? 'image'}](/images/changelog/${info.image})`,
			content,
		].join('\n\n');
	}

	public async updateHtml() {
		if (!this.panel?.visible) {
			return;
		}

		const releaseId = await this.getLastPublish();
		if (!releaseId) {
			return;
		}

		const mdContent = await this.loadChangelog(releaseId);
		if (!mdContent) {
			return;
		}

		const html = await vscode.commands.executeCommand<string>('markdown.api.render', mdContent);
		this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<base href="https://www.gitpod.io/">
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Gitpod Release Notes</title>
	<style>
		video {
			max-width: 100%;
			width: 100%;
		}
	</style>
	<style>
		${DEFAULT_MARKDOWN_STYLES}
	</style>
</head>
	<body>
		${html}
	</body>
</html>`;
		if (releaseId !== this.lastReadId) {
			await this.context.globalState.update(ReleaseNotes.RELEASE_NOTES_LAST_READ_KEY, releaseId);
			this.lastReadId = releaseId;
		}
	}

	private async showIfNewRelease(lastReadId: string | undefined) {
		const showReleaseNotes = vscode.workspace.getConfiguration('gitpod').get<boolean>('showReleaseNotes');
		if (showReleaseNotes) {
			const releaseId = await this.getLastPublish();
			if (releaseId && releaseId !== lastReadId) {
				console.log(`gitpod release notes lastReadId: ${lastReadId}, latestReleaseId: ${releaseId}`);
				this.createOrShow();
			}
		}
	}

	public createOrShow() {
		if (this.panel) {
			this.panel.reveal();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			ReleaseNotes.viewType,
			'Gitpod Release Notes',
			vscode.ViewColumn.Beside,
			{ enableScripts: true },
		);
		this.panel.onDidDispose(() => {
			disposeAll(this.panelDisposables);
			this.panel = undefined;
			this.panelDisposables = [];
		}, null, this.panelDisposables);
		this.panel.onDidChangeViewState(
			() => this.updateHtml(),
			null,
			this.panelDisposables
		);
		this.updateHtml();
	}

	override dispose() {
		super.dispose();
		disposeAll(this.panelDisposables);
		this.panel?.dispose();
	}
}

// Align with https://github.com/gitpod-io/openvscode-server/blob/494f7eba3615344ee634e6bec0b20a1903e5881d/src/vs/workbench/contrib/markdown/browser/markdownDocumentRenderer.ts#L14
const DEFAULT_MARKDOWN_STYLES = `
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
