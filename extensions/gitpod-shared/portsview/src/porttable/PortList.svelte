<!-----------------------------------------------------------------------------------------------
	Copyright (c) Gitpod. All rights reserved.
------------------------------------------------------------------------------------------------>
<script lang="ts">
	import PortInfo from "./PortInfo.svelte";
	import PortStatus from "./PortStatus.svelte";
	import { vscode } from "../utils/vscodeApi";
	import type { GitpodPortObject, PortCommand } from "../protocol/gitpod";
	import PortHoverActions from "./PortHoverActions.svelte";

	function postData(command: string, port: GitpodPortObject) {
		vscode.postMessage({
			port,
			command: command as PortCommand,
		});
	}

	export let ports: GitpodPortObject[] = [];
</script>

<main>
	<div class="container">
		{#each ports as port, i (port.status.localPort)}
			<PortHoverActions
				{port}
				on:command={(e) => {
					postData(e.detail, port);
				}}
			>
				<div class="line" title={port.info.tooltip}>
					<div class="status">
						<PortStatus port={port} />
					</div>
					<div class="info">
						<PortInfo {port} />
					</div>
					<div class="desc">
						<span title={port.info.description}>{port.info.description}</span>
					</div>
				</div>
			</PortHoverActions>
		{/each}
	</div>
</main>

<style>
	.container {
		padding: 0 5px;
		font-size: 13px;
	}
	.line {
		display: flex;
		width: 100%;
		padding: 4px 0;
		gap: 0.5rem;
	}
	.desc, .line {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.desc {
		color: var(--vscode-disabledForeground)
	}
</style>
