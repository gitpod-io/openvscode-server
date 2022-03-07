/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const path = require('path');
const fs = require('fs');
const https = require('https');

const pickKeys = [
	'extensionTips', 'extensionImportantTips', 'keymapExtensionTips',
	'configBasedExtensionTips', 'extensionKeywords', 'extensionAllowedBadgeProviders',
	'extensionAllowedBadgeProvidersRegex', 'extensionAllowedProposedApi',
	'extensionEnabledApiProposals', 'extensionKind', 'languageExtensionTips'
];

async function start() {
	const releasePath = path.join(__dirname, '../product-release.json');
	if (!fs.existsSync(releasePath)) {
		console.error('product-release.json is not exists, please copy product.json from VSCode Desktop Stable');
		return;
	}
	const branchProduct = JSON.parse(fs.readFileSync(path.join(__dirname, '../product.json')).toString());
	const releaseProduct = JSON.parse(fs.readFileSync(releasePath).toString());
	const tmpProductPath = path.join(__dirname, '../product-tmp.json');
	for (let key of pickKeys) {
		branchProduct[key] = releaseProduct[key];
	}
	fs.writeFileSync(tmpProductPath, JSON.stringify(branchProduct, null, 4));

	if (keysDiff(branchProduct, releaseProduct)) {
		// allow-any-unicode-next-line
		console.log('📦 check if you need these keys or not');
	}
	await checkProductExtensions(branchProduct);
	// allow-any-unicode-next-line
	console.log('📦 you can copy product-tmp.json file to product.json file and resolve logs above by yourself');
	// allow-any-unicode-next-line
	console.log('✅ done');
}

const AllowMissKeys = [
	'win32SetupExeBasename',
	'darwinCredits',
	'darwinExecutable',
	'downloadUrl',
	'updateUrl',
	'webEndpointUrl',
	'webEndpointUrlTemplate',
	'quality',
	'exeBasedExtensionTips',
	'webExtensionTips',
	'remoteExtensionTips',
	'crashReporter',
	'appCenter',
	'enableTelemetry',
	'aiConfig',
	'msftInternalDomains',
	'sendASmile',
	'documentationUrl',
	'releaseNotesUrl',
	'keyboardShortcutsUrlMac',
	'keyboardShortcutsUrlLinux',
	'keyboardShortcutsUrlWin',
	'introductoryVideosUrl',
	'tipsAndTricksUrl',
	'newsletterSignupUrl',
	'twitterUrl',
	'requestFeatureUrl',
	'reportMarketplaceIssueUrl',
	'privacyStatementUrl',
	'showTelemetryOptOut',
	'npsSurveyUrl',
	'cesSurveyUrl',
	'checksumFailMoreInfoUrl',
	'electronRepository',
	'settingsSearchUrl',
	'surveys',
	'tasConfig',
	'experimentsUrl',
	'extensionSyncedKeys',
	'extensionVirtualWorkspacesSupport',
	'auth',
	'configurationSync.store',
	'commit',
	'date',
	'checksums',
	'settingsSearchBuildId',
	'darwinUniversalAssetId',
];

function keysDiff(branch, release) {
	const toMap = (ret, e) => {
		ret[e] = true;
		return ret;
	};
	const map1 = Object.keys(branch).reduce(toMap, {});
	const map2 = Object.keys(release).reduce(toMap, {});
	let changed = false;
	for (let key in branch) {
		if (!!!map2[key]) {
			changed = true;
			// allow-any-unicode-next-line
			console.log(`🟠 Remove key: ${key}`);
		}
	}
	for (let key in release) {
		if (!!!map1[key] && !AllowMissKeys.includes(key)) {
			changed = true;
			// allow-any-unicode-next-line
			console.log(`🟠 Add key: ${key}`);
		}
	}
	return changed;
}

async function checkProductExtensions(product) {
	const uniqueExtIds = new Set();
	// Allow extension that downloaded from ms marketplace by users to use proposed api
	// uniqueExtIds.push(...product.extensionAllowedProposedApi);

	// Check recommand extension tips
	for (let key in product.configBasedExtensionTips) {
		Object.keys(product.configBasedExtensionTips[key].recommendations ?? {}).forEach(id => uniqueExtIds.add(id));
	}
	Object.keys(product.extensionImportantTips).forEach(id => uniqueExtIds.add(id));
	Object.keys(product.extensionTips).forEach(id => uniqueExtIds.add(id));
	Object.keys(product.extensionEnabledApiProposals).forEach(id => uniqueExtIds.add(id));
	product.keymapExtensionTips.forEach(id => uniqueExtIds.add(id));
	product.languageExtensionTips.forEach(id => uniqueExtIds.add(id));

	// Check if extensions exists in openvsx
	for (let id of uniqueExtIds) {
		const openvsxUrl = `https://open-vsx.org/api/${id.replace(/\./g, '/')}`;
		const ok = await urlExists(openvsxUrl);
		if (!ok) {
			// allow-any-unicode-next-line
			console.error(`🔴 Extension not exists: ${id}`);
		}
	}
}

async function urlExists(url) {
	return new Promise((resolve, reject) => {
		https.get(url, res => {
			resolve(res.statusCode === 200);
		}).on('error', error => {
			reject(error);
		});
	});
}

start().then().catch(console.error);
