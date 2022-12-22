
import * as grpc from '@grpc/grpc-js';
import * as fs from 'fs';

export function isGRPCErrorStatus<T extends grpc.status>(err: any, status: T): boolean {
	return err && typeof err === 'object' && 'code' in err && err.code === status;
}

export async function exists(path: string) {
	try {
		await fs.promises.access(path);
		return true;
	} catch {
		return false;
	}
}
