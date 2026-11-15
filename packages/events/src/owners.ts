import type { Settings } from './settings.ts';

export type Admission = 'allowed' | 'claimed' | 'denied';

/**
 * Who may talk to this bot. A bot token that leaks reaches an agent that
 * spends the owner's credits, so the first chat to arrive becomes the owner
 * and everyone else is told to go away. `ALLOWED_USERS` adds people on top.
 */
export class Owners {
	constructor(
		private readonly settings: Settings,
		private readonly extra: readonly string[] = [],
	) {}

	check(channel: string, identity: string): Admission {
		if (this.extra.includes(identity)) return 'allowed';
		const owner = this.settings.get(`owner:${channel}`);
		if (owner === undefined) {
			this.settings.set(`owner:${channel}`, identity);
			return 'claimed';
		}
		return owner === identity ? 'allowed' : 'denied';
	}

	owner(channel: string): string | undefined {
		return this.settings.get(`owner:${channel}`);
	}
}
