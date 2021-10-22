interface TrackVSCodeSession {
	eventName: 'vscode_session',
	optionalProperties: {
		phase: 'start' | 'running' | 'end'
	}
}

interface TrackGitpodOpenLink {
	eventName: 'vscode_execute_command_gitpod_open_link',
	optionalProperties: {
		url: string
	}
}

interface TrackGitpodChangeVSCodeType {
	eventName: 'vscode_execute_command_gitpod_change_vscode_type',
	optionalProperties: {
		type: 'browser' | 'desktop',
		version?: 'insiders'
	}
}

interface TrackGitpodWorkspace {
	eventName: 'vscode_execute_command_gitpod_workspace',
	optionalProperties: {
		action: 'share' | 'stop-sharing' | 'stop' | 'snapshot' | 'extend-timeout'
	}
}

interface TrackGitpodPorts {
	eventName: 'vscode_execute_command_gitpod_ports',
	optionalProperties: {
		action: 'private' | 'public' | 'preview' | 'openBrowser'
	}
}

interface TrackGitpodConfig {
	eventName: 'vscode_execute_command_gitpod_config',
	optionalProperties: {
		action: 'remove' | 'add'
	}
}

export type GitpodAnalyticsEvent = TrackVSCodeSession |
	TrackGitpodOpenLink |
	TrackGitpodChangeVSCodeType |
	TrackGitpodWorkspace |
	TrackGitpodPorts |
	TrackGitpodConfig;
