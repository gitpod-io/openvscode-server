<!-----------------------------------------------------------------------------------------------
	Copyright (c) Gitpod. All rights reserved.
------------------------------------------------------------------------------------------------>
<script lang="ts">
	import { createEventDispatcher } from "svelte";
	import HoverOptions from "../components/HoverOptions.svelte";
	import type { HoverOption } from "../protocol/components";
	import type { GitpodPortObject, PortCommand } from "../protocol/gitpod";
	import { commandIconMap, getCommands, getNLSTitle } from "../utils/commands";

	export let port: GitpodPortObject;
	export let alwaysShow: boolean = false;

	const copyOpt: HoverOption = {
		icon: "copy",
		title: "Copy URL",
		command: "urlCopy",
	};

	function getHoverOption(port?: GitpodPortObject) {
		if (port == null) {
			return [];
		}
		const opts: HoverOption[] = getCommands(port).map((e) => ({
			icon: commandIconMap[e],
			title: getNLSTitle(e),
			command: e,
		}));
		opts.unshift(copyOpt);
		return opts;
	}

	$: hoverOpts = getHoverOption(port);
	const dispatch = createEventDispatcher<{
		command: PortCommand;
	}>();
	function onHoverCommand(command: string) {
		dispatch("command", command as PortCommand);
	}
</script>

<HoverOptions
	alwaysShow={alwaysShow}
	options={hoverOpts}
	on:command={(e) => {
		onHoverCommand(e.detail);
	}}
>
	<slot />
</HoverOptions>
