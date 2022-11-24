/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import nlsFile from 'package.nls.json';
import type { GitpodPortObject, PortCommand } from '../protocol/gitpod';
// eslint-disable-next-line no-duplicate-imports
import { PortCommands } from '../protocol/gitpod';

// TODO: use vscode-nls
export function getNLSTitle(command: PortCommand) {
	let name: string = command;
	switch (name) {
		case 'preview':
			name = 'openPreview';
	}
	return nlsFile[name] ?? command as string;
}

export const commandIconMap: Record<PortCommand, string> = {
	tunnelNetwork: 'eye',
	tunnelHost: 'eye-closed',
	makePublic: 'lock',
	makePrivate: 'unlock',
	preview: 'open-preview',
	openBrowser: 'globe',
	retryAutoExpose: 'refresh',
	urlCopy: 'copy',
	queryPortData: '',
};

let supportedCommands: PortCommand[] = [...PortCommands];
window.addEventListener('message', (event) => {
	if (event.data.command === 'supportedCommands') {
		supportedCommands = event.data.commands;
	}
});

export function getCommands(port: GitpodPortObject): PortCommand[] {
	return getSplitCommands(port).filter(e => !!e) as PortCommand[];
}

export function getSplitCommands(port: GitpodPortObject) {
	const opts: Array<null | PortCommand> = [];
	const viewItem = port.info.contextValue;
	if (viewItem.includes('host') && viewItem.includes('tunneled')) {
		opts.push('tunnelNetwork');
	}
	if (viewItem.includes('network') && viewItem.includes('tunneled')) {
		opts.push('tunnelHost');
	}
	if (opts.length > 0) {
		opts.push(null);
	}
	if (viewItem.includes('private')) {
		opts.push('makePublic');
	}
	if (viewItem.includes('public')) {
		opts.push('makePrivate');
	}
	if (viewItem.includes('exposed') || viewItem.includes('tunneled')) {
		opts.push('preview');
		opts.push('openBrowser');
	}
	if (viewItem.includes('failed')) {
		if (opts.length > 0) {
			opts.push(null);
		}
		opts.push('retryAutoExpose');
	}
	if (supportedCommands.length > 0) {
		return opts.filter(e => e === null || supportedCommands.includes(e));
	}
	return opts;
}
