/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const KNOW_HOST_FILE = path.join(os.homedir(), '.ssh', 'known_hosts');
const HASH_MAGIC = '|1|';
const HASH_DELIM = '|';

export async function checkNewHostInHostkeys(host: string): Promise<boolean> {
	const fileContent = await fs.promises.readFile(KNOW_HOST_FILE, { encoding: 'utf8' });
	const lines = fileContent.split(/\r?\n/);
	for (let line of lines) {
		line = line.trim();
		if (!line.startsWith(HASH_MAGIC)) {
			continue;
		}

		const [hostEncripted_] = line.split(' ');
		const [salt_, hostHash_] = hostEncripted_.substring(HASH_MAGIC.length).split(HASH_DELIM);
		const hostHash = crypto.createHmac('sha1', Buffer.from(salt_, 'base64')).update(host).digest();
		if (hostHash.toString('base64') === hostHash_) {
			return false;
		}
	}

	return true;
}

export async function addHostToHostFile(host: string, hostKey: Buffer, type: string): Promise<void> {
	const salt = crypto.randomBytes(20);
	const hostHash = crypto.createHmac('sha1', salt).update(host).digest();

	const entry = `${HASH_MAGIC}${salt.toString('base64')}${HASH_DELIM}${hostHash.toString('base64')} ${type} ${hostKey.toString('base64')}\n`;
	await fs.promises.appendFile(KNOW_HOST_FILE, entry);
}
