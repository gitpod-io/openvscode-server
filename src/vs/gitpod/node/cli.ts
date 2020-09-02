/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { parseArgs } from 'vs/platform/environment/node/argv';
import { main, OPTIONS, sendCommand, ServerNativeParsedArgs } from 'vs/server/node/cli.main';

interface GitpodNativeParsedArgs extends ServerNativeParsedArgs {
	preview?: string
}

Object.assign(OPTIONS, {
	preview: {
		type: 'string',
	}
});

const devMode = !!process.env['VSCODE_DEV'];

let port = 3000;
if (!devMode && process.env.GITPOD_THEIA_PORT) {
	port = Number(process.env.GITPOD_THEIA_PORT);
}
const reqOptions: http.RequestOptions = {
	hostname: 'localhost',
	port,
	protocol: 'http:',
	path: '/cli',
	method: 'POST'
};

main<GitpodNativeParsedArgs>(process.argv, {
	parseArgs: (args, errorReporter) => parseArgs(args, OPTIONS, errorReporter),
	handleArgs: async args => {
		if (!args.preview) {
			return false;
		}
		await sendCommand(reqOptions, {
			type: 'preview',
			url: args.preview
		} as any);
		return true;
	},
	createRequestOptions: () => reqOptions
});
