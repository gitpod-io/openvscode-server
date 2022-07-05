/* eslint-disable code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IProductService } from 'vs/platform/product/common/productService';
import { ITelemetryAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { mapTelemetryData, SenderKind } from 'vs/gitpod/common/insightsHelper';

export class GitpodInsightsAppender implements ITelemetryAppender {
	private _baseProperties: { appName: string; uiKind: 'web'; version: string };
	constructor(
		@IProductService private readonly productService: IProductService
	) {

		this._baseProperties = {
			appName: this.productService.nameShort,
			uiKind: 'web',
			version: this.productService.version,
		};
	}

	public log(eventName: string, data: any): void {
		const trackMessage = mapTelemetryData(SenderKind.Browser, eventName, data);
		if (!trackMessage) {
			return;
		}
		trackMessage.properties = {
			...trackMessage.properties,
			...this._baseProperties,
		};
		window.postMessage({ type: 'vscode_telemetry', event: trackMessage.event, properties: trackMessage.properties }, '*');
	}

	public flush(): Promise<any> {
		return Promise.resolve(undefined);
	}
}
