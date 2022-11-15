/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buffer } from './zip';

type ExtensionKind = 'ui' | 'workspace' | 'web';

interface IExtensionManifest {
	readonly name: string;
	readonly displayName?: string;
	readonly publisher: string;
	readonly version: string;
	readonly engines: { readonly vscode: string };
	readonly description?: string;
	readonly main?: string;
	readonly browser?: string;
	readonly icon?: string;
	readonly categories?: string[];
	readonly keywords?: string[];
	readonly activationEvents?: string[];
	readonly extensionDependencies?: string[];
	readonly extensionPack?: string[];
	readonly extensionKind?: ExtensionKind | ExtensionKind[];
	readonly contributes?: any;
	readonly repository?: { url: string };
	readonly bugs?: { url: string };
	readonly enableProposedApi?: boolean;
	readonly api?: string;
	readonly scripts?: { [key: string]: string };
	readonly capabilities?: any;
}

export function getVsixManifest(vsix: string): Promise<IExtensionManifest> {
	return buffer(vsix, 'extension/package.json')
		.then(buffer => {
			try {
				return JSON.parse(buffer.toString('utf8'));
			} catch (err) {
				throw new Error('VSIX invalid: package.json is not a JSON file.');
			}
		});
}

interface IRawGalleryExtensionFile {
	readonly assetType: string;
	readonly source: string;
}

interface IRawGalleryExtensionProperty {
	readonly key: string;
	readonly value: string;
}

interface IRawGalleryExtensionVersion {
	readonly version: string;
	readonly lastUpdated: string;
	readonly assetUri: string;
	readonly fallbackAssetUri: string;
	readonly files: IRawGalleryExtensionFile[];
	readonly properties?: IRawGalleryExtensionProperty[];
	readonly targetPlatform?: string;
}

interface IRawGalleryExtensionStatistics {
	readonly statisticName: string;
	readonly value: number;
}

interface IRawGalleryExtensionPublisher {
	readonly displayName: string;
	readonly publisherId: string;
	readonly publisherName: string;
	readonly domain?: string | null;
	readonly isDomainVerified?: boolean;
}

interface IRawGalleryExtension {
	readonly extensionId: string;
	readonly extensionName: string;
	readonly displayName: string;
	readonly shortDescription: string;
	readonly publisher: IRawGalleryExtensionPublisher;
	readonly versions: IRawGalleryExtensionVersion[];
	readonly statistics: IRawGalleryExtensionStatistics[];
	readonly tags: string[] | undefined;
	readonly releaseDate: string;
	readonly publishedDate: string;
	readonly lastUpdated: string;
	readonly categories: string[] | undefined;
	readonly flags: string;
}

export interface IRawGalleryQueryResult {
	readonly results: {
		readonly extensions: IRawGalleryExtension[];
		readonly resultMetadata: {
			readonly metadataType: string;
			readonly metadataItems: {
				readonly name: string;
				readonly count: number;
			}[];
		}[];
	}[];
}
