/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { PortsStatus, PortAutoExposure, PortVisibility, ExposedPortInfo } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { URL } from 'url';

export interface ExposedPort extends PortsStatus.AsObject {
	exposed: ExposedPortInfo.AsObject;
}

export function isExposedPort(port: PortsStatus.AsObject | undefined): port is ExposedPort {
	return !!port?.exposed;
}

export interface ExposedServedPort extends ExposedPort {
	served: true;
}

export function isExposedServedPort(port: PortsStatus.AsObject | undefined): port is ExposedServedPort {
	return isExposedPort(port) && !!port.served;
}

export interface ExposedServedGitpodWorkspacePort extends GitpodWorkspacePort {
	status: ExposedServedPort;
}

export function isExposedServedGitpodWorkspacePort(port: GitpodWorkspacePort | undefined): port is ExposedServedGitpodWorkspacePort {
	return port instanceof GitpodWorkspacePort && isExposedServedPort(port.status);
}

export interface TunnelDescriptionI {
	remoteAddress: { port: number; host: string };
	//The complete local address(ex. localhost:1234)
	localAddress: { port: number; host: string } | string;
	/**
	 * @deprecated Use privacy instead
	 */
	public?: boolean;
	privacy?: string;
	// If protocol is not provided it is assumed to be http, regardless of the localAddress.
	protocol?: string;
}

export type IconStatus = 'Served' | 'NotServed' | 'Detecting' | 'ExposureFailed';

export const iconStatusMap: Record<IconStatus, { icon: string; color?: string }> = {
	Served: {
		icon: 'circle-filled',
		color: 'ports.iconRunningProcessForeground',
	},
	NotServed: {
		icon: 'circle-outline',
	},
	Detecting: {
		icon: 'circle-filled',
		color: 'editorWarning.foreground',
	},
	ExposureFailed: {
		icon: 'warning',
		color: 'editorWarning.foreground',
	},
};

export interface PortInfo {
	label: string;
	tooltip: string;
	description: string;
	iconStatus: IconStatus;
	contextValue: string;
	localUrl: string;
}

export class GitpodWorkspacePort {
	public info: PortInfo;
	public status: PortsStatus.AsObject;
	public localUrl: string;
	constructor(
		readonly portNumber: number,
		portStatus: PortsStatus.AsObject,
		private tunnel?: TunnelDescriptionI,
	) {
		this.status = portStatus;
		this.tunnel = tunnel;
		this.info = this.parsePortInfo(portStatus, tunnel);
		this.localUrl = 'http://localhost:' + portStatus.localPort;
	}

	update(portStatus: PortsStatus.AsObject, tunnel?: TunnelDescriptionI) {
		this.status = portStatus;
		this.tunnel = tunnel;
		this.info = this.parsePortInfo(portStatus, tunnel);
	}

	private parsePortInfo(portStatus: PortsStatus.AsObject, tunnel?: TunnelDescriptionI) {
		const currentStatus = portStatus;
		const { name, localPort, description, exposed, served } = currentStatus;
		// const prevStatus = port.status;
		const port: PortInfo = {
			label: '',
			tooltip: '',
			description: '',
			contextValue: '',
			iconStatus: 'NotServed',
			localUrl: 'http://localhost:' + localPort,
		};
		port.label = name ? `${name}: ${localPort}` : `${localPort}`;
		if (description) {
			port.tooltip = name ? `${name} - ${description}` : description;
		}

		if (this.remotePort && this.remotePort !== localPort) {
			port.label += ':' + this.remotePort;
		}

		const accessible = exposed || tunnel;

		const isPortTunnelPublic = tunnel?.privacy === 'public';
		if (!served) {
			port.description = 'not served';
			port.iconStatus = 'NotServed';
		} else if (!accessible) {
			if (portStatus.autoExposure === PortAutoExposure.FAILED) {
				port.description = 'failed to expose';
				port.iconStatus = 'ExposureFailed';
			} else {
				port.description = 'detecting...';
				port.iconStatus = 'Detecting';
			}
		} else {
			port.description = 'open';
			if (tunnel) {
				port.description += ` on ${isPortTunnelPublic ? 'all interfaces' : 'localhost'}`;
			}
			if (exposed) {
				port.description += ` ${exposed.visibility === PortVisibility.PUBLIC ? '(public)' : '(private)'}`;
			}
			port.iconStatus = 'Served';
		}

		port.contextValue = 'port';
		if (served) {
			port.contextValue = 'served-' + port.contextValue;
		}
		if (exposed) {
			port.contextValue = 'exposed-' + port.contextValue;
			port.contextValue = (exposed.visibility === PortVisibility.PUBLIC ? 'public-' : 'private-') + port.contextValue;
		}
		if (tunnel) {
			port.contextValue = 'tunneled-' + port.contextValue;
			port.contextValue = (isPortTunnelPublic ? 'network-' : 'host-') + port.contextValue;
		}
		if (!accessible && portStatus.autoExposure === PortAutoExposure.FAILED) {
			port.contextValue = 'failed-' + port.contextValue;
		}
		return port;
	}

	toSvelteObject() {
		return {
			info: this.info,
			status: {
				...this.status,
				remotePort: this.remotePort,
			},
		};
	}

	get externalUrl(): string {
		if (this.tunnel) {
			const localAddress = typeof this.tunnel.localAddress === 'string' ? this.tunnel.localAddress : this.tunnel.localAddress.host + ':' + this.tunnel.localAddress.port;
			return localAddress.startsWith('http') ? localAddress : `http://${localAddress}`;
		}
		return this.status?.exposed?.url || this.localUrl;
	}

	get remotePort(): number | undefined {
		if (this.tunnel) {
			if (typeof this.tunnel.localAddress === 'string') {
				try {
					return Number(new URL(this.tunnel.localAddress).port);
				} catch {
					return undefined;
				}
			}
			return this.tunnel.localAddress.port;
		}
		return undefined;
	}
}
