/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import { GitpodExtensionContext } from 'gitpod-shared';
import * as util from 'util';
import * as path from 'path';

export interface IExtensionIdentifier {
	id: string;
	uuid?: string;
}

export interface ISyncExtension {
	identifier: IExtensionIdentifier;
	preRelease?: boolean;
	version?: string;
	disabled?: boolean;
	installed?: boolean;
	state?: Record<string, any>;
}

let vscodeProductJson: any;
async function getVSCodeProductJson() {
	if (!vscodeProductJson) {
		const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
		vscodeProductJson = JSON.parse(productJsonStr);
	}

	return vscodeProductJson;
}

export async function initializeRemoteExtensions(extensions: ISyncExtension[], context: GitpodExtensionContext) {
	if (!extensions || !extensions.length) {
		return true;
	}

	const productJson = await getVSCodeProductJson();
	const appName = productJson.applicationName || 'code';
	const codeCliPath = path.join(vscode.env.appRoot, 'bin/remote-cli', appName);
	const args = extensions.map(e => '--install-extension ' + e.identifier.id).join(' ');

	try {
		context.logger.trace('Trying to initialize remote extensions:', extensions.map(e => e.identifier.id).join('\n'));
		const { stderr } = await util.promisify(cp.exec)(`${codeCliPath} ${args}`);
		if (stderr) {
			context.logger.error('Failed to initialize remote extensions:', stderr);
		}
	} catch (e) {
		context.logger.error('Error trying to initialize remote extensions:', e);
	}

	return true;
}

export async function installInitialExtensions(context: GitpodExtensionContext) {
	context.logger.info('installing initial extensions...');
	const extensions: (vscode.Uri | string)[] = [];
	try {
		const workspaceContextUri = vscode.Uri.parse(context.info.getWorkspaceContextUrl());
		extensions.push('redhat.vscode-yaml');
		if (/github\.com/i.test(workspaceContextUri.authority)) {
			extensions.push('github.vscode-pull-request-github');
		}

		let config: { vscode?: { extensions?: string[] } } | undefined;
		try {
			const configUri = vscode.Uri.file(path.join(context.info.getCheckoutLocation(), '.gitpod.yml'));
			const buffer = await vscode.workspace.fs.readFile(configUri);
			const content = new TextDecoder().decode(buffer);
			const model = new context.config.GitpodPluginModel(content);
			config = model.document.toJSON();
		} catch { }
		if (config?.vscode?.extensions) {
			const extensionIdRegex = /^([^.]+\.[^@]+)(@(\d+\.\d+\.\d+(-.*)?))?$/;
			for (const extension of config.vscode.extensions) {
				let link: vscode.Uri | undefined;
				try {
					link = vscode.Uri.parse(extension.trim(), true);
					if (link.scheme !== 'http' && link.scheme !== 'https') {
						link = undefined;
					}
				} catch { }
				if (link) {
					extensions.push(link);
				} else {
					const normalizedExtension = extension.toLocaleLowerCase();
					if (extensionIdRegex.exec(normalizedExtension)) {
						extensions.push(normalizedExtension);
					}
				}
			}
		}
	} catch (e) {
		context.logger.error('Failed to detect workspace context dependent extensions:', e);
	}

	if (!extensions.length) {
		return;
	}

	const productJson = await getVSCodeProductJson();
	const appName = productJson.applicationName || 'code';
	const codeCliPath = path.join(vscode.env.appRoot, 'bin/remote-cli', appName);
	const args = extensions.map(e => '--install-extension ' + e.toString()).join(' ');

	try {
		context.logger.trace('Trying to initialize remote extensions from gitpod.yml:', extensions.map(e => e.toString()).join('\n'));
		const { stderr } = await util.promisify(cp.exec)(`${codeCliPath} ${args}`);
		if (stderr) {
			context.logger.error('Failed to initialize remote extensions from gitpod.yml:', stderr);
		}
	} catch (e) {
		context.logger.error('Error trying to initialize remote extensions from gitpod.yml:', e);
	}
}
