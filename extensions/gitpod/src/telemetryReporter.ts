import { AppenderData, BaseTelemetryAppender, BaseTelemetryClient, BaseTelemetryReporter } from './common/telemetry';
import SegmentAnalytics from 'analytics-node';
import * as os from 'os';
import * as vscode from 'vscode';

const analyticsClientFactory = async (key: string): Promise<BaseTelemetryClient> => {
	let segmentAnalyticsClient = new SegmentAnalytics(key);

	// Sets the analytics client into a standardized form
	const telemetryClient: BaseTelemetryClient = {
		logEvent: (eventName: string, data?: AppenderData) => {
			try {
				segmentAnalyticsClient.track({
					anonymousId: vscode.env.machineId,
					event: eventName,
					properties: data?.properties
				});
			} catch (e: any) {
				throw new Error('Failed to log event to app analytics!\n' + e.message);
			}
		},
		logException: (_exception: Error, _data?: AppenderData) => {
			throw new Error('Failed to log exception to app analytics!\n');
		},
		flush: async () => {
			try {
				// Types are oudated, flush does return a promise
				await segmentAnalyticsClient.flush();
			} catch (e: any) {
				throw new Error('Failed to flush app analytics!\n' + e.message);
			}
		}
	};
	return telemetryClient;
};

export default class TelemetryReporter extends BaseTelemetryReporter {
	constructor(extensionId: string, extensionVersion: string, key: string) {
		const appender = new BaseTelemetryAppender(key, (key) => analyticsClientFactory(key));
		super(extensionId, extensionVersion, appender, {
			release: os.release(),
			platform: os.platform(),
			architecture: os.arch(),
		});
	}
}
