/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { WorkbenchPhase } from '../../../common/contributions.js';
import { BrowserDefaultChatAgentContribution } from './browserDefaultChatAgent.js';

// Register the browser default chat agent contribution
registerWorkbenchContribution2(
	BrowserDefaultChatAgentContribution.ID,
	BrowserDefaultChatAgentContribution,
	WorkbenchPhase.AfterRestored
);
