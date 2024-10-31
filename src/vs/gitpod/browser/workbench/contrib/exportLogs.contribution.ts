/* eslint-disable local/code-import-patterns */
/* eslint-disable header/header */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IBrowserWorkbenchEnvironmentService } from '../../../../workbench/services/environment/browser/environmentService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import * as resources from '../../../../base/common/resources.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type * as zipModule from '@zip.js/zip.js';
import { Schemas } from '../../../../base/common/network.js';
import { triggerDownload } from '../../../../base/browser/dom.js';
import { importAMDNodeModule } from '../../../../amdX.js';

const getZipModule = (function () {
	let zip: typeof zipModule;
	return async () => {
		if (!zip) {
			// when actually importing the module change `zip.js` to `zipjs`
			// without the dot because loader.js will do a check for `.js` extension
			// and it won't resolve the module path correctly
			// @ts-ignore
			zip = await importAMDNodeModule<typeof import('@zip.js/zip.js')>('@zip.js/zip.js', 'dist/zip-no-worker-deflate.min.js');
			zip.configure({
				useWebWorkers: false
			});
		}
		return zip;
	};
})();

registerAction2(class ExportLogsAction extends Action2 {
	constructor() {
		super({
			id: 'gitpod.workbench.exportLogs',
			title: { original: 'Export all logs', value: 'Export all logs' },
			category: { original: 'Gitpod', value: 'Gitpod' },
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const progressService = accessor.get(IProgressService);
		const fileService = accessor.get(IFileService);
		const environmentService = accessor.get(IBrowserWorkbenchEnvironmentService);
		const remoteAgentService = accessor.get(IRemoteAgentService);

		const cts = new CancellationTokenSource();
		const bufferData = await progressService.withProgress<Uint8Array | undefined>(
			{
				location: ProgressLocation.Dialog,
				title: 'Exporting logs to zip file ...',
				cancellable: true,
				delay: 1000
			},
			async progress => {
				const token = cts.token;

				const zip = await getZipModule();
				const uint8ArrayWriter = new zip.Uint8ArrayWriter();
				const writer = new zip.ZipWriter(uint8ArrayWriter);

				if (token.isCancellationRequested) {
					return undefined;
				}

				const entries: { name: string; resource: URI }[] = [];
				const logsPath = environmentService.windowLogsPath;
				const stat = await fileService.resolve(logsPath);
				if (stat.children) {
					entries.push(...stat.children.filter(stat => !stat.isDirectory).map(stat => ({ name: resources.basename(stat.resource), resource: stat.resource })));
				}

				if (token.isCancellationRequested) {
					return undefined;
				}

				const remoteEnv = await remoteAgentService.getEnvironment();
				const remoteLogsPath = remoteEnv?.logsPath;
				if (remoteLogsPath) {
					const remoteAgentLogFile = resources.joinPath(remoteLogsPath, 'remoteagent.log');
					if (await fileService.exists(remoteAgentLogFile)) {
						entries.push({ name: resources.basename(remoteAgentLogFile), resource: remoteAgentLogFile });
					}
				}

				if (token.isCancellationRequested) {
					return undefined;
				}

				const remoteExtHostLogsPath = remoteEnv?.extensionHostLogsPath;
				if (remoteExtHostLogsPath) {
					const remoteExtHostLogsFile = resources.joinPath(remoteExtHostLogsPath, 'exthost.log');
					if (await fileService.exists(remoteExtHostLogsFile)) {
						entries.push({ name: resources.basename(remoteExtHostLogsFile), resource: remoteExtHostLogsFile });
					}

					let stat = await fileService.resolve(remoteExtHostLogsPath);
					if (stat.children) {
						const ouputLoggingDirs = stat.children.filter(stat => stat.isDirectory);
						for (const outLogDir of ouputLoggingDirs) {
							if (token.isCancellationRequested) {
								return undefined;
							}

							stat = await fileService.resolve(outLogDir.resource);
							if (stat.children) {
								entries.push(...stat.children.filter(stat => !stat.isDirectory).map(stat => ({
									name: `${resources.basename(outLogDir.resource)}_${resources.basename(stat.resource)}`,
									resource: stat.resource
								})));
							}
						}
					}
				}

				if (token.isCancellationRequested) {
					return undefined;
				}

				const credentialHelperPath = URI.file('/tmp/gitpod-git-credential-helper.log').with({ scheme: Schemas.vscodeRemote });
				if (await fileService.exists(credentialHelperPath)) {
					entries.push({ name: resources.basename(credentialHelperPath), resource: credentialHelperPath });
				}
				const supervisorPath = URI.file('/var/log/gitpod/supervisor.log').with({ scheme: Schemas.vscodeRemote });
				if (await fileService.exists(supervisorPath)) {
					entries.push({ name: resources.basename(supervisorPath), resource: supervisorPath });
				}
				const dockerUpPath = URI.file('/workspace/.gitpod/logs/docker-up.log').with({ scheme: Schemas.vscodeRemote });
				if (await fileService.exists(dockerUpPath)) {
					entries.push({ name: resources.basename(dockerUpPath), resource: dockerUpPath });
				}

				console.log('All log entries', entries);

				for (const entry of entries) {
					if (token.isCancellationRequested) {
						return undefined;
					}
					const content = await fileService.readFile(entry.resource, { atomic: true }, token);

					if (token.isCancellationRequested) {
						return undefined;
					}
					await writer.add(entry.name, new zip.Uint8ArrayReader(content.value.buffer));
				}

				return writer.close();
			},
			() => cts.dispose(true)
		);

		if (bufferData) {
			triggerDownload(bufferData, `vscode-web-logs-${new Date().toISOString().replace(/-|:|\.\d+Z$/g, '')}.zip`);
		}
	}
});
