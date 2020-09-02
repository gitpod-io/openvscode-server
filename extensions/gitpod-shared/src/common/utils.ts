
import * as grpc from '@grpc/grpc-js';

export function isGRPCErrorStatus<T extends grpc.status>(err: any, status: T): boolean {
	return err && typeof err === 'object' && 'code' in err && err.code === status;
}
