/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// This code is based on https://github.com/microsoft/vscode-extension-telemetry

import * as vscode from 'vscode';
import { Disposable } from './dispose';

const enum TelemetryLevel {
	ON = 'on',
	ERROR = 'error',
	OFF = 'off'
}

function getTelemetryLevel(): TelemetryLevel {
	const TELEMETRY_CONFIG_ID = 'telemetry';
	const TELEMETRY_CONFIG_ENABLED_ID = 'enableTelemetry';

	if (vscode.env.isTelemetryEnabled !== undefined) {
		return vscode.env.isTelemetryEnabled ? TelemetryLevel.ON : TelemetryLevel.OFF;
	}

	// We use the old and new setting to determine the telemetry level as we must respect both
	const config = vscode.workspace.getConfiguration(TELEMETRY_CONFIG_ID);
	const enabled = config.get<boolean>(TELEMETRY_CONFIG_ENABLED_ID);
	return enabled ? TelemetryLevel.ON : TelemetryLevel.OFF;
}

export interface TelemetryEventProperties {
	readonly [key: string]: string;
}

export interface RawTelemetryEventProperties {
	readonly [key: string]: any;
}

export interface AppenderData {
	properties?: RawTelemetryEventProperties;
}

export interface ITelemetryAppender {
	logEvent(eventName: string, data?: AppenderData): void;
	logException(exception: Error, data?: AppenderData): void;
	flush(): void | Promise<void>;
	instantiateAppender(): void;
}

export interface BaseTelemetryClient {
	logEvent(eventName: string, data?: AppenderData): void;
	logException(exception: Error, data?: AppenderData): void;
	flush(): void | Promise<void>;
}

export class BaseTelemetryAppender implements ITelemetryAppender {
	// Whether or not the client has been instantiated
	private _isInstantiated = false;
	private _telemetryClient: BaseTelemetryClient | undefined;

	// Queues used to store events until the appender is ready
	private _eventQueue: Array<{ eventName: string; data: AppenderData | undefined }> = [];
	private _exceptionQueue: Array<{ exception: Error; data: AppenderData | undefined }> = [];

	// Necessary information to create a telemetry client
	private _clientFactory: (key: string) => Promise<BaseTelemetryClient>;
	private _key: string;

	constructor(key: string, clientFactory: (key: string) => Promise<BaseTelemetryClient>) {
		this._clientFactory = clientFactory;
		this._key = key;
		if (getTelemetryLevel() !== TelemetryLevel.OFF) {
			this.instantiateAppender();
		}
	}

	/**
	 * Sends the event to the passed in telemetry client
	 * @param eventName The named of the event to log
	 * @param data The data contanied in the event
	 */
	logEvent(eventName: string, data?: AppenderData): void {
		if (!this._telemetryClient) {
			if (!this._isInstantiated && getTelemetryLevel() === TelemetryLevel.ON) {
				this._eventQueue.push({ eventName, data });
			}
			return;
		}
		this._telemetryClient.logEvent(eventName, data);
	}

	/**
	 * Sends an exception to the passed in telemetry client
	 * @param exception The exception to collect
	 * @param data Data associated with the exception
	 */
	logException(exception: Error, data?: AppenderData): void {
		if (!this._telemetryClient) {
			if (!this._isInstantiated && getTelemetryLevel() !== TelemetryLevel.OFF) {
				this._exceptionQueue.push({ exception, data });
			}
			return;
		}
		this._telemetryClient.logException(exception, data);
	}

	/**
	 * Flushes the buffered telemetry data
	 */
	async flush(): Promise<void> {
		if (this._telemetryClient) {
			await this._telemetryClient.flush();
			this._telemetryClient = undefined;
		}
	}

	/**
	 * Flushes the queued events that existed before the client was instantiated
	 */
	private _flushQueues(): void {
		this._eventQueue.forEach(({ eventName, data }) => this.logEvent(eventName, data));
		this._eventQueue = [];
		this._exceptionQueue.forEach(({ exception, data }) => this.logException(exception, data));
		this._exceptionQueue = [];
	}

	/**
	 * Instantiates the telemetry client to make the appender "active"
	 */
	instantiateAppender(): void {
		if (this._isInstantiated) {
			return;
		}
		// Call the client factory to get the client and then let it know it's instatntiated
		this._clientFactory(this._key).then(client => {
			this._telemetryClient = client;
			this._isInstantiated = true;
			this._flushQueues();
		}).catch(err => {
			console.error(err);
		});
	}
}

export class BaseTelemetryReporter extends Disposable {
	private userOptIn = false;
	private errorOptIn = false;
	private _extension: vscode.Extension<any> | undefined;

	constructor(
		private extensionId: string,
		private extensionVersion: string,
		private telemetryAppender: ITelemetryAppender,
		private osShim: { release: string; platform: string; architecture: string },
	) {
		super();

		this.updateUserOptStatus();

		if (vscode.env.onDidChangeTelemetryEnabled !== undefined) {
			this._register(vscode.env.onDidChangeTelemetryEnabled(() => this.updateUserOptStatus()));
			this._register(vscode.workspace.onDidChangeConfiguration(() => this.updateUserOptStatus()));
		} else {
			this._register(vscode.workspace.onDidChangeConfiguration(() => this.updateUserOptStatus()));
		}
	}

	/**
	 * Updates whether the user has opted in to having telemetry collected
	 */
	private updateUserOptStatus(): void {
		const telemetryLevel = getTelemetryLevel();
		this.userOptIn = telemetryLevel === TelemetryLevel.ON;
		this.errorOptIn = telemetryLevel === TelemetryLevel.ERROR || this.userOptIn;
		if (this.userOptIn || this.errorOptIn) {
			this.telemetryAppender.instantiateAppender();
		}
	}

	/**
	 * Retrieves the current extension based on the extension id
	 */
	private get extension(): vscode.Extension<any> | undefined {
		if (this._extension === undefined) {
			this._extension = vscode.extensions.getExtension(this.extensionId);
		}

		return this._extension;
	}

	/**
	 * Given an object and a callback creates a clone of the object and modifies it according to the callback
	 * @param obj The object to clone and modify
	 * @param change The modifying function
	 * @returns A new changed object
	 */
	private cloneAndChange(obj?: { [key: string]: string }, change?: (key: string, val: string) => string): { [key: string]: string } | undefined {
		if (obj === null || typeof obj !== 'object') { return obj; }
		if (typeof change !== 'function') { return obj; }

		const ret: { [key: string]: string } = {};
		for (const key in obj) {
			ret[key] = change(key, obj[key]!);
		}

		return ret;
	}

	/**
	 * Whether or not it is safe to send error telemetry
	 */
	private shouldSendErrorTelemetry(): boolean {
		if (this.errorOptIn === false) {
			return false;
		}

		return true;
	}

	// __GDPR__COMMON__ "common.os" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.nodeArch" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.platformversion" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.extname" : { "classification": "PublicNonPersonalData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.extversion" : { "classification": "PublicNonPersonalData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.vscodemachineid" : { "endPoint": "MacAddressHash", "classification": "EndUserPseudonymizedInformation", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.vscodesessionid" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.vscodeversion" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.uikind" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	// __GDPR__COMMON__ "common.product" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
	private getCommonProperties(): TelemetryEventProperties {
		const commonProperties = Object.create(null);
		commonProperties['common.os'] = this.osShim.platform;
		commonProperties['common.nodeArch'] = this.osShim.architecture;
		commonProperties['common.platformversion'] = (this.osShim.release || '').replace(/^(\d+)(\.\d+)?(\.\d+)?(.*)/, '$1$2$3');
		commonProperties['common.extname'] = this.extensionId;
		commonProperties['common.extversion'] = this.extensionVersion;
		if (vscode && vscode.env) {
			commonProperties['common.vscodemachineid'] = vscode.env.machineId;
			commonProperties['common.vscodesessionid'] = vscode.env.sessionId;
			commonProperties['common.vscodeversion'] = vscode.version;
			commonProperties['common.product'] = vscode.env.appHost;

			switch (vscode.env.uiKind) {
				case vscode.UIKind.Web:
					commonProperties['common.uikind'] = 'web';
					break;
				case vscode.UIKind.Desktop:
					commonProperties['common.uikind'] = 'desktop';
					break;
				default:
					commonProperties['common.uikind'] = 'unknown';
			}
		}
		return commonProperties;
	}

	/**
	 * Given an error stack cleans up the file paths within
	 * @param stack The stack to clean
	 * @param anonymizeFilePaths Whether or not to clean the file paths or anonymize them as well
	 * @returns The cleaned stack
	 */
	private anonymizeFilePaths(stack?: string, anonymizeFilePaths?: boolean): string {
		let result: RegExpExecArray | null | undefined;
		if (stack === undefined || stack === null) {
			return '';
		}

		const cleanupPatterns = [];
		if (vscode.env.appRoot !== '') {
			cleanupPatterns.push(new RegExp(vscode.env.appRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
		}
		if (this.extension) {
			cleanupPatterns.push(new RegExp(this.extension.extensionPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
		}

		let updatedStack = stack;

		if (anonymizeFilePaths) {
			const cleanUpIndexes: [number, number][] = [];
			for (const regexp of cleanupPatterns) {
				while ((result = regexp.exec(stack))) {
					if (!result) {
						break;
					}
					cleanUpIndexes.push([result.index, regexp.lastIndex]);
				}
			}

			const nodeModulesRegex = /^[\\/]?(node_modules|node_modules\.asar)[\\/]/;
			const fileRegex = /(file:\/\/)?([a-zA-Z]:(\\\\|\\|\/)|(\\\\|\\|\/))?([\w-._]+(\\\\|\\|\/))+[\w-._]*/g;
			let lastIndex = 0;
			updatedStack = '';

			while ((result = fileRegex.exec(stack))) {
				if (!result) {
					break;
				}
				// Anoynimize user file paths that do not need to be retained or cleaned up.
				if (result[0] && !nodeModulesRegex.test(result[0]) && cleanUpIndexes.every(([x, y]) => result!.index < x || result!.index >= y)) {
					updatedStack += stack.substring(lastIndex, result.index) + '<REDACTED: user-file-path>';
					lastIndex = fileRegex.lastIndex;
				}
			}
			if (lastIndex < stack.length) {
				updatedStack += stack.substr(lastIndex);
			}
		}

		// sanitize with configured cleanup patterns
		for (const regexp of cleanupPatterns) {
			updatedStack = updatedStack.replace(regexp, '');
		}
		return updatedStack;
	}

	private removePropertiesWithPossibleUserInfo(properties: TelemetryEventProperties | undefined): TelemetryEventProperties | undefined {
		if (typeof properties !== 'object') {
			return;
		}
		const cleanedObject = Object.create(null);
		// Loop through key and values of the properties object
		for (const key of Object.keys(properties)) {
			const value = properties[key];
			// If for some reason it is undefined we skip it (this shouldn't be possible);
			if (!value) {
				continue;
			}

			// Regex which matches @*.site
			const emailRegex = /@[a-zA-Z0-9-.]+/;
			const secretRegex = /(key|token|sig|signature|password|passwd|pwd|android:value)[^a-zA-Z0-9]/;
			// last +? is lazy as a microoptimization since we don't care about the full value
			const tokenRegex = /xox[pbaors]-[a-zA-Z0-9]+-[a-zA-Z0-9-]+?/;

			// Check for common user data in the telemetry events
			if (secretRegex.test(value.toLowerCase())) {
				cleanedObject[key] = '<REDACTED: secret>';
			} else if (emailRegex.test(value)) {
				cleanedObject[key] = '<REDACTED: email>';
			} else if (tokenRegex.test(value)) {
				cleanedObject[key] = '<REDACTED: token>';
			} else {
				cleanedObject[key] = value;
			}
		}
		return cleanedObject;
	}

	public get telemetryLevel(): 'all' | 'error' | 'crash' | 'off' {
		const telemetryLevel = getTelemetryLevel();
		switch (telemetryLevel) {
			case TelemetryLevel.ON:
				return 'all';
			case TelemetryLevel.ERROR:
				return 'error';
			case TelemetryLevel.OFF:
				return 'off';
		}
	}

	/**
	 * Given an event name, some properties, and measurements sends a telemetry event.
	 * Properties are sanitized on best-effort basis to remove sensitive data prior to sending.
	 * @param eventName The name of the event
	 * @param properties The properties to send with the event
	 */
	public sendTelemetryEvent(eventName: string, properties?: TelemetryEventProperties): void {
		if (this.userOptIn && eventName !== '') {
			properties = { ...properties, ...this.getCommonProperties() };
			const cleanProperties = this.cloneAndChange(properties, (_key: string, prop: string) => this.anonymizeFilePaths(prop, false));
			this.telemetryAppender.logEvent(`${eventName}`, { properties: this.removePropertiesWithPossibleUserInfo(cleanProperties) });
		}
	}

	/**
	 * Given an event name, some properties, and measurements sends a raw (unsanitized) telemetry event
	 * @param eventName The name of the event
	 * @param properties The properties to send with the event
	 */
	public sendRawTelemetryEvent(eventName: string, properties?: RawTelemetryEventProperties): void {
		if (this.userOptIn && eventName !== '') {
			properties = { ...properties, ...this.getCommonProperties() };
			this.telemetryAppender.logEvent(`${eventName}`, { properties });
		}
	}

	/**
	 * Given an event name, some properties, and measurements sends an error event
	 * @param eventName The name of the event
	 * @param properties The properties to send with the event
	 * @param errorProps If not present then we assume all properties belong to the error prop and will be anonymized
	 */
	public sendTelemetryErrorEvent(eventName: string, properties?: { [key: string]: string }, errorProps?: string[]): void {
		if (this.errorOptIn && eventName !== '') {
			// always clean the properties if first party
			// do not send any error properties if we shouldn't send error telemetry
			// if we have no errorProps, assume all are error props
			properties = { ...properties, ...this.getCommonProperties() };
			const cleanProperties = this.cloneAndChange(properties, (key: string, prop: string) => {
				if (this.shouldSendErrorTelemetry()) {
					return this.anonymizeFilePaths(prop, false);
				}

				if (errorProps === undefined || errorProps.indexOf(key) !== -1) {
					return 'REDACTED';
				}

				return this.anonymizeFilePaths(prop, false);
			});
			this.telemetryAppender.logEvent(`${eventName}`, { properties: this.removePropertiesWithPossibleUserInfo(cleanProperties) });
		}
	}

	/**
	 * Given an error, properties, and measurements. Sends an exception event
	 * @param error The error to send
	 * @param properties The properties to send with the event
	 */
	public sendTelemetryException(error: Error, properties?: TelemetryEventProperties): void {
		if (this.shouldSendErrorTelemetry() && this.errorOptIn && error) {
			properties = { ...properties, ...this.getCommonProperties() };
			const cleanProperties = this.cloneAndChange(properties, (_key: string, prop: string) => this.anonymizeFilePaths(prop, false));
			// Also run the error stack through the anonymizer
			if (error.stack) {
				error.stack = this.anonymizeFilePaths(error.stack, false);
			}
			this.telemetryAppender.logException(error, { properties: this.removePropertiesWithPossibleUserInfo(cleanProperties) });
		}
	}

	public override async dispose(): Promise<any> {
		await this.telemetryAppender.flush();
		super.dispose();
	}
}
