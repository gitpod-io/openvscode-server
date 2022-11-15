/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let vscodeProductJson: any;
export async function getVSCodeProductJson() {
	if (!vscodeProductJson) {
		const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
		vscodeProductJson = JSON.parse(productJsonStr);
	}

	return vscodeProductJson;
}
