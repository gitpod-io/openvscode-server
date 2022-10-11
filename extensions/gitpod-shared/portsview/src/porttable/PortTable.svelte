<!-----------------------------------------------------------------------------------------------
	Copyright (c) Gitpod. All rights reserved.
------------------------------------------------------------------------------------------------>
<script lang="ts">
	import {
		provideVSCodeDesignSystem,
		vsCodeDataGrid,
		vsCodeDataGridCell,
		vsCodeDataGridRow,
	} from "@vscode/webview-ui-toolkit";
	import ContextMenu from "../components/ContextMenu.svelte";
	import PortInfo from "./PortInfo.svelte";
	import PortStatus from "./PortStatus.svelte";
	import PortLocalAddress from "./PortLocalAddress.svelte";
	import { vscode } from "../utils/vscodeApi";
	import type { GitpodPortObject, PortCommand } from "../protocol/gitpod";
	import { getNLSTitle, getSplitCommands } from "../utils/commands";
	import type { MenuOption } from "../protocol/components";
	import PortHoverActions from './PortHoverActions.svelte';

	provideVSCodeDesignSystem().register(
		vsCodeDataGrid(),
		vsCodeDataGridCell(),
		vsCodeDataGridRow()
	);

	let tableHovered = false;

	function postData(command: string, port: GitpodPortObject) {
		vscode.postMessage({
			port,
			command: command as PortCommand,
		});
	}

	export let ports: GitpodPortObject[] = [];

	//#region ContextMenu

	let menuData: {
		x: number;
		y: number;
		show: boolean;
		port: GitpodPortObject;
		options: MenuOption[];
	} = {
		x: 0,
		y: 0,
		show: false,
		port: undefined,
		options: [],
	};

	async function onRightClick(event, port) {
		if (menuData.show) {
			menuData.show = false;
			await new Promise((res) => setTimeout(res, 100));
		}
		menuData.options = getSplitCommands(port).map((e) =>
			!!e ? { command: e, label: getNLSTitle(e) } : null
		);
		menuData.port = port;
		menuData.x = event.x;
		menuData.y = event.y;
		menuData.show = true;
	}

	function closeMenu() {
		menuData.show = false;
	}

	//#endregion

	//#region Responsive

	let innerWidth = 0

	const responsiveMap: Record<number, {layout: string; headers: string[]; options?: { allInPort?: boolean; }}> = {
		850: {
			layout: "50px 180px 1fr 180px 180px",
			headers: ["", "Port", "Address", "Description", "State"],
		},
		700: {
			layout: "50px 180px 1fr 180px",
			headers: ["", "Port", "Address", "State"],
		},
		500: {
			layout: "50px 180px 1fr 108px",
			headers: ["", "Port", "State", "Action"],
		}
	}

	const sortedResponsiveKeys = Object.keys(responsiveMap).map(e => Number(e)).sort((a, b) => b - a)

	$: useResponsive = responsiveMap[sortedResponsiveKeys.find(e => innerWidth > e) ?? 850]

	//#endregion

</script>

<main>
	<ContextMenu
		{...menuData}
		on:clickoutside={closeMenu}
		on:command={(e) => {
			const command = e.detail;
			postData(command, menuData.port);
			closeMenu();
		}}
	/>

	<vscode-data-grid
		class="table"
		id="table"
		grid-template-columns={useResponsive.layout}
		class:table-hover={tableHovered}
		on:contextmenu|preventDefault
		on:mouseenter={() => (tableHovered = true)}
		on:mouseleave={() => (tableHovered = false)}
	>
		<vscode-data-grid-row class="tr" row-type="sticky-header">
			{#each useResponsive.headers as header, i (i)}
				<vscode-data-grid-cell
					class="th"
					cellType="columnheader"
					grid-column={i + 1}>{header}</vscode-data-grid-cell
				>
			{/each}
		</vscode-data-grid-row>
		{#each ports as port, i (port.status.localPort)}
			<vscode-data-grid-row
				class="tr tr-data"
				on:contextmenu|preventDefault={(event) => onRightClick(event, port)}
			>
				{#if useResponsive.headers.includes("")}
					<vscode-data-grid-cell grid-column={useResponsive.headers.indexOf("") + 1}
						class="td"
						class:served={port.status.served}
						style="text-align: center"
					>
						<PortStatus port={port} />
					</vscode-data-grid-cell>
				{/if}

				{#if useResponsive.headers.includes("Port")}
					<vscode-data-grid-cell grid-column={useResponsive.headers.indexOf("Port") + 1} class="td">
						<PortInfo {port} />
					</vscode-data-grid-cell>
				{/if}

				{#if useResponsive.headers.includes("Address")}
					<vscode-data-grid-cell grid-column={useResponsive.headers.indexOf("Address") + 1} class="td">
						{#if (port.status.exposed?.url.length ?? 0) > 0}
							<PortLocalAddress
								on:command={(e) => {
									const { command, port } = e.detail;
									postData(command, port);
								}}
								{port}
							/>
						{/if}
					</vscode-data-grid-cell>
				{/if}

				{#if useResponsive.headers.includes("Description")}
					<vscode-data-grid-cell grid-column={useResponsive.headers.indexOf("Description") + 1} class="td">
						<span title={port.status.description}>{port.status.description}</span>
					</vscode-data-grid-cell>
				{/if}

				{#if useResponsive.headers.includes("State")}
					<vscode-data-grid-cell grid-column={useResponsive.headers.indexOf("State") + 1} class="td">
						<span title={port.info.description}>{port.info.description}</span>
					</vscode-data-grid-cell>
				{/if}

				{#if useResponsive.headers.includes("Action")}
					<vscode-data-grid-cell grid-column={useResponsive.headers.indexOf("Action") + 1} class="td">
						<PortHoverActions port={port} alwaysShow on:command={(e) => { postData(e.detail, port) }} />
					</vscode-data-grid-cell>
				{/if}
			</vscode-data-grid-row>
		{/each}
	</vscode-data-grid>
</main>

<svelte:window
	bind:innerWidth
	on:scroll={() => {
		if (menuData.show) {
			menuData.show = false;
		}
	}}
/>

<style>
	.table {
		width: 100%;
		height: 100%;
		font-size: 13px;
	}
	.td {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.th {
		font-weight: bold;
	}

	.tr-data:nth-child(odd) {
		background-color: var(--vscode-tree-tableOddRowsBackground);
	}
	.tr-data:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
</style>
