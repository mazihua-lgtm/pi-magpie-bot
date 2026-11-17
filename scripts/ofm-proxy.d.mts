export interface ProxyOptions {
	upstream?: string;
	port?: number;
	key?: string;
	keyFile?: string;
	lanes?: string[];
	timeoutMs?: number;
}

export interface ProxyHandle {
	server: import('node:http').Server;
	lanes(): string[];
	refresh(): Promise<string[]>;
	listen(port?: number, host?: string): Promise<unknown>;
	close(): Promise<void>;
}

export const STABLE_MODEL: string;
export function createProxy(options?: ProxyOptions): ProxyHandle;
