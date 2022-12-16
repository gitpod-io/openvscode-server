/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const CACHE_KEY = 'gitpod.cache';

interface CacheObject {
	value: any;
	expiration?: number;
}

interface CacheMap { [key: string]: CacheObject }

export class CacheHelper {
	constructor(private readonly context: vscode.ExtensionContext) { }

	set(key: string, value: any, expiration?: number) {
		let obj = this.context.globalState.get<CacheMap>(CACHE_KEY);
		if (!obj) {
			obj = {};
		}
		const exp = expiration ? (Date.now() / 1000 + expiration) : undefined;
		obj[key] = { value, expiration: exp };
		return this.context.globalState.update(CACHE_KEY, obj);
	}

	get<T>(key: string): T | undefined {
		const value = this.context.globalState.get<CacheMap>(CACHE_KEY);
		if (!value || !value[key]) {
			return undefined;
		}
		const data = value[key];
		if (!data.expiration) {
			return data.value;
		}
		const now = Date.now() / 1000;
		return now > data.expiration ? undefined : data.value;
	}

	async getOrRefresh<T>(key: string, refreshCallback: () => Thenable<{ value: T; ttl?: number }>): Promise<T | undefined> {
		let value = this.get<T>(key);
		if (value === undefined) {
			try {
				const result = await refreshCallback();
				await this.set(key, result.value, result.ttl);
				value = result.value;
			} catch {
			}
		}
		return value;
	}
}
