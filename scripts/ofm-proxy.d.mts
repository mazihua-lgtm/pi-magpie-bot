export interface ExternalLane {
	name?: string;
	url: string;
	model: string;
	key?: string;
}

export interface ProxyOptions {
	upstream?: string;
	port?: number;
	key?: string;
	keyFile?: string;
	lanes?: string[];
	/** Endpoints outside the free pool: tried after it, and sent no key unless one is given. */
	extra?: ExternalLane[];
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
export const DEFAULT_EXTERNAL: ExternalLane[];
export function createProxy(options?: ProxyOptions): ProxyHandle;
