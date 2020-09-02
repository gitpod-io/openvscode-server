/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isWeb } from '../../../../base/common/platform.js';
import { IProductConfiguration } from '../../../../base/common/product.js';

// This is required so that webview resources load sucessfully in firefox
// Firefox is more strict regarding CSP rules and it will complain if we left
// the `webviewResourceBaseHost` set to 'vscode-cdn.net' as the service worker
// is served from a different domain in this case `baseHost`.
export let baseHost: string | undefined;
if (isWeb) {
	baseHost = (globalThis as any).env?.['GITPOD_CODE_HOST'];
} else {
	baseHost = process.env['GITPOD_CODE_HOST'];
}
baseHost ??= 'gitpod.io';
if (/^https?:\/\//.test(baseHost)) {
	try {
		baseHost = new URL(baseHost).host;
	} catch { }
}

export function addCustomGitpodProductProperties(product: IProductConfiguration): IProductConfiguration {
	const openvsxUrl = atob('aHR0cHM6Ly9vcGVuLXZzeC5vcmc='); // Hack to avoid being replaced by blobserve, remove in the future
	return {
		...product,
		linkProtectionTrustedDomains: [
			// ...(product.linkProtectionTrustedDomains || []),
			`https://open-vsx.${baseHost}`,
			openvsxUrl
		],
		extensionsGallery: {
			serviceUrl: `https://open-vsx.${baseHost}/vscode/gallery`,
			extensionUrlTemplate: `${openvsxUrl}/vscode/gallery/{publisher}/{name}/latest`,
			resourceUrlTemplate: `${openvsxUrl}/vscode/unpkg/{publisher}/{name}/{version}/{path}`, // Hardcoded for now until open-vsx proxy is fixed
			controlUrl: `https://ide.${baseHost}/code/marketplace.json`,
			nlsBaseUrl: '',
		},
		'configurationSync.store': {
			url: `https://${baseHost}/code-sync`,
			stableUrl: `https://${baseHost}/code-sync`,
			insidersUrl: `https://${baseHost}/code-sync`,
			canSwitch: false,
			authenticationProviders: {
				gitpod: {
					scopes: ['function:accessCodeSyncStorage']
				}
			}
		},
		'editSessions.store': {
			url: `https://${baseHost}/code-sync`,
			canSwitch: false,
			authenticationProviders: {
				gitpod: {
					scopes: ['function:accessCodeSyncStorage']
				}
			}
		},
	};
}
