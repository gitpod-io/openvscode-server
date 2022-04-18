/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Logger, Application } from '../../../../automation';
import { installAllHandlers, retryWithRestart } from '../../utils';

export function setup(logger: Logger) {

	describe('Localization', () => {

		// Shared before/after handling
		installAllHandlers(logger);

		it('starts with "DE" locale and verifies title and viewlets text is in German', async function () {
			this.timeout(2 * 60 * 1000); // https://github.com/microsoft/vscode/issues/146800

			const app = this.app as Application;

			await retryWithRestart(app, async () => {
				await app.workbench.extensions.openExtensionsViewlet();
				await app.workbench.extensions.installExtension('ms-ceintl.vscode-language-pack-de', false);
				await app.restart({ extraArgs: ['--locale=DE'] });

				const result = await app.workbench.localization.getLocalizedStrings();
				const localeInfo = await app.workbench.localization.getLocaleInfo();

				if (localeInfo.locale === undefined || localeInfo.locale.toLowerCase() !== 'de') {
					throw new Error(`The requested locale for VS Code was not German. The received value is: ${localeInfo.locale === undefined ? 'not set' : localeInfo.locale}`);
				}

				if (localeInfo.language.toLowerCase() !== 'de') {
					throw new Error(`The UI language is not German. It is ${localeInfo.language}`);
				}

				if (result.open.toLowerCase() !== 'öffnen' || result.close.toLowerCase() !== 'schließen' || result.find.toLowerCase() !== 'finden') {
					throw new Error(`Received wrong German localized strings: ${JSON.stringify(result, undefined, 0)}`);
				}
			});
		});
	});
}
