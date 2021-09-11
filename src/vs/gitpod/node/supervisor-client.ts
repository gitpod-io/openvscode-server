/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import * as grpc from '@grpc/grpc-js';
import product from 'vs/platform/product/common/product';

export const supervisorDeadlines = {
	long: 30 * 1000,
	normal: 15 * 1000,
	short: 5 * 1000
};
export const supervisorMetadata = new grpc.Metadata();
const supervisorClientOptions: Partial<grpc.ClientOptions> = {
	'grpc.primary_user_agent': `${product.nameLong}/${product.version} Server`,
};
export const supervisorAddr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
export const infoServiceClient = new InfoServiceClient(supervisorAddr, grpc.credentials.createInsecure(), supervisorClientOptions);
