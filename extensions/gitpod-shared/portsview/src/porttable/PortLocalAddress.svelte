<!-----------------------------------------------------------------------------------------------
	Copyright (c) Gitpod. All rights reserved.
------------------------------------------------------------------------------------------------>
<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import type { GitpodPortObject, PortCommand } from "../protocol/gitpod";
	import PortHoverActions from "./PortHoverActions.svelte";

	export let port: GitpodPortObject;

	const dispatch = createEventDispatcher<{
		command: { command: PortCommand; port: GitpodPortObject };
	}>();
	function openAddr() {
		if (port.status.exposed.url) {
			dispatch("command", { command: "openBrowser" as PortCommand, port });
		}
	}
</script>

<PortHoverActions
	{port}
	alwaysShow
	on:command={(e) => { dispatch("command", { command: e.detail, port}) }}
>
<!-- svelte-ignore a11y-invalid-attribute -->
	<a on:click={() => { openAddr(); return false; }} href="javascript:void(0)">{port.status.exposed.url}</a>
</PortHoverActions>

<style>
	a {
		color: var(--vscode-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a:focus {
		outline: none;
	}
</style>
