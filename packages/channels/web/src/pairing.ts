/**
 * One-time codes for pairing a phone to this assistant.
 *
 * The QR never carries the password: it carries a short code that is created
 * only after someone is already logged in, lives for five minutes, and is
 * destroyed on first use. Trading it in signs the caller's own session, so the
 * phone gets the same `sid + auth` a browser login would have - and the code is
 * worthless to anyone who only photographs it.
 *
 * Codes are memory-only: a restart forgets them, which is the point. No table,
 * no cleanup thread, nothing to back up.
 */
import { networkInterfaces } from 'node:os';
import { randomInt } from 'node:crypto';

export const PAIR_TTL_MS = 5 * 60_000;
/** Readable: no 0/O or 1/I confusion when someone has to type it by hand. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface PairCode {
	expiresAt: number;
}

export class PairStore {
	private readonly codes = new Map<string, PairCode>();
	/** Failed exchanges per remote address: a code is short, so guessing must be slow. */
	private readonly misses = new Map<string, { count: number; until: number }>();

	create(now = Date.now()): { code: string; expiresAt: number } {
		let code = '';
		do {
			code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
		} while (this.codes.has(code));
		const expiresAt = now + PAIR_TTL_MS;
		this.codes.set(code, { expiresAt });
		this.prune(now);
		return { code, expiresAt };
	}

	/** Consumes the code: a second exchange with the same one always fails. */
	consume(code: string, now = Date.now()): boolean {
		const found = this.codes.get(code);
		if (!found || found.expiresAt <= now) {
			this.codes.delete(code);
			return false;
		}
		this.codes.delete(code);
		return true;
	}

	throttled(who: string, now = Date.now()): boolean {
		const miss = this.misses.get(who);
		return Boolean(miss && miss.count >= 10 && now < miss.until);
	}

	miss(who: string, now = Date.now()): void {
		const miss = this.misses.get(who) ?? { count: 0, until: now + 10 * 60_000 };
		if (now >= miss.until) {
			miss.count = 0;
			miss.until = now + 10 * 60_000;
		}
		miss.count += 1;
		this.misses.set(who, miss);
	}

	clearMiss(who: string): void {
		this.misses.delete(who);
	}

	private prune(now: number): void {
		for (const [code, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(code);
	}
}

/**
 * The address to put in the QR. A host behind Docker or a Wi-Fi router can
 * rarely guess its own LAN address, so `PAIR_HOST` wins and the first private
 * IPv4 that is not loopback is the fallback. Returns undefined when there is
 * nothing a phone on the LAN could reach, so the caller can say so plainly.
 */
export function lanAddress(override?: string): string | undefined {
	if (override?.trim()) return override.trim().replace(/\/.*$/, '');
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family !== 'IPv4' || address.internal) continue;
			if (address.address.startsWith('127.')) continue;
			return address.address;
		}
	}
	return undefined;
}

/** The exact string the QR encodes; the app recognises this one shape. */
export function pairLink(address: string, port: number, code: string): string {
	return `http://${address}:${port}/pair/${code}`;
}
