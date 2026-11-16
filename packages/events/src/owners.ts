import type { Settings } from './settings.ts';

export type Admission = 'allowed' | 'claimed' | 'denied';

/**
 * Who may talk to this bot. A bot token that leaks reaches an agent that
 * spends the owner's credits, so the first chat to arrive becomes the owner
 * and everyone else is told to go away. `ALLOWED_USERS` adds people on top;
 * when it is given, the list is the whole answer and nobody can claim the bot
 * by getting there first.
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
			if (this.extra.length > 0) return 'denied';
			this.settings.set(`owner:${channel}`, identity);
			return 'claimed';
		}
		return owner === identity ? 'allowed' : 'denied';
	}

	owner(channel: string): string | undefined {
		return this.settings.get(`owner:${channel}`);
	}
}
