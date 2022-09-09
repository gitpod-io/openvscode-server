/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as configcat from 'configcat-node';
import * as configcatcommon from 'configcat-common';
import * as semver from 'semver';
import Log from 'gitpod-shared/out/common/logger';
import { URL } from 'url';

const EXPERTIMENTAL_SETTINGS = [
	'gitpod.experimental.portsView.enabled',
];

export class ExperimentalSettings {
	private configcatClient: configcatcommon.IConfigCatClient;
	private extensionVersion: semver.SemVer;

	constructor(key: string, extensionVersion: string, private logger: Log, gitpodHost: string) {
		this.configcatClient = configcat.createClientWithLazyLoad(key, {
			baseUrl: new URL('/configcat', process.env['VSCODE_DEV'] ? 'https://gitpod-staging.com' : gitpodHost).href,
			logger: {
				debug(): void { },
				log(): void { },
				info(): void { },
				warn(message: string): void { logger.warn(`ConfigCat: ${message}`); },
				error(message: string): void { logger.error(`ConfigCat: ${message}`); }
			},
			requestTimeoutMs: 1500,
			cacheTimeToLiveSeconds: 60
		});
		this.extensionVersion = new semver.SemVer(extensionVersion);
	}

	async get<T>(key: string, userId?: string, custom?: { [key: string]: string }): Promise<T | undefined> {
		const config = vscode.workspace.getConfiguration('gitpod');
		const values = config.inspect<T>(key.substring('gitpod.'.length));
		if (!values || !EXPERTIMENTAL_SETTINGS.includes(key)) {
			this.logger.error(`Cannot get invalid experimental setting '${key}'`);
			return values?.globalValue ?? values?.defaultValue;
		}
		if (this.isPreRelease()) {
			// PreRelease versions always have experiments enabled by default
			return values.globalValue ?? values.defaultValue;
		}
		if (values.globalValue !== undefined) {
			// User setting have priority over configcat so return early
			return values.globalValue;
		}

		const user = userId ? new configcatcommon.User(userId, undefined, undefined, custom) : undefined;
		const configcatKey = key.replace(/\./g, '_'); // '.' are not allowed in configcat
		const experimentValue = (await this.configcatClient.getValueAsync(configcatKey, undefined, user)) as T | undefined;

		return experimentValue ?? values.defaultValue;
	}

	async inspect<T>(key: string, userId?: string, custom?: { [key: string]: string }): Promise<{ key: string; defaultValue?: T; globalValue?: T; experimentValue?: T } | undefined> {
		const config = vscode.workspace.getConfiguration('gitpod');
		const values = config.inspect<T>(key.substring('gitpod.'.length));
		if (!values || !EXPERTIMENTAL_SETTINGS.includes(key)) {
			this.logger.error(`Cannot inspect invalid experimental setting '${key}'`);
			return values;
		}

		const user = userId ? new configcatcommon.User(userId, undefined, undefined, custom) : undefined;
		const configcatKey = key.replace(/\./g, '_'); // '.' are not allowed in configcat
		const experimentValue = (await this.configcatClient.getValueAsync(configcatKey, undefined, user)) as T | undefined;

		return { key, defaultValue: values.defaultValue, globalValue: values.globalValue, experimentValue };
	}

	forceRefreshAsync(): Promise<void> {
		return this.configcatClient.forceRefreshAsync();
	}

	private isPreRelease() {
		return this.extensionVersion.minor % 2 === 1;
	}

	dispose(): void {
		this.configcatClient.dispose();
	}
}

export function isUserOverrideSetting(key: string): boolean {
	const config = vscode.workspace.getConfiguration('gitpod');
	const values = config.inspect(key.substring('gitpod.'.length));
	return values?.globalValue !== undefined;
}
