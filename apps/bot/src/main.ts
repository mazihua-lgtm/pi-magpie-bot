/**
 * The thing you run. It starts a chat surface (Telegram, a local web page, or
 * both), opens the agent, and keeps the loop going until Ctrl-C.
 *
 * Everything is configured by environment variables so the same entry point
 * works on a laptop and in a container; see README for the list.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Bot } from '@pi-magpie-bot/brain';
import { TelegramChannel } from '@pi-magpie-bot/channel-telegram';
import { WebChannel } from '@pi-magpie-bot/channel-web';
import {
	ensureFreeRoute,
	ensureGateway,
	findMagpieBinary,
	FREE_GROUP,
	FREE_MODEL_PREFIX,
	FREE_PLUGIN,
	gatewayConfig,
	listModels,
} from '@pi-magpie-bot/gateway';

/** A `.env` beside the checkout, so a user can set a token in a text editor. */
function loadDotEnv(path: string): void {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const at = trimmed.indexOf('=');
		if (at <= 0) continue;
		const key = trimmed.slice(0, at).trim();
		const raw = trimmed
			.slice(at + 1)
			.trim()
			.replace(/^['"]|['"]$/g, '');
		const value = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

loadDotEnv(join(process.cwd(), '.env'));

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? join(homedir(), '.pi-magpie-bot'));

console.log('[bot] starting up');
console.log(`[bot] data in ${dataDir}`);

const config = gatewayConfig();
const log = (line: string) => console.error(`[gateway] ${line}`);
/** Our own magpie, when this machine has none the user put there. */
const ourBinDir = join(dataDir, 'bin');

/**
 * A gateway that is down is started or waited for; one that answers with a
 * refusal is not down at all, so send the user to the key instead of a timeout.
 */
async function models(): Promise<{ ids: string[]; binary?: string }> {
	try {
		return { ids: (await listModels(config)).map((model) => model.id) };
	} catch (error) {
		if (/\b(401|403|429)\b/.test(String(error))) {
			console.error('[bot] magpie refused this gateway key');
			console.error('[bot] a shared gateway has its own keys; make one and put it in .env as MAGPIE_API_KEY:');
			console.error('[bot]   magpie gateway-key add bot');
			process.exit(1);
		}
		// No magpie at all on this machine: the release is fetched and checked
		// rather than sending someone who only has Node off to install it.
		const started = await ensureGateway(config, {
			start: env.MAGPIE_START !== '0',
			installDir: ourBinDir,
			log,
		});
		return { ids: (await listModels(config)).map((model) => model.id), binary: started.binary };
	}
}

const reachable = await models();
let ids = reachable.ids;

// A brand-new gateway has no routing groups. Run the two commands the README
// lists, rather than making the user copy them out of an error message. A
// gateway someone already filled with their own models is left alone.
const wanted = env.MAGPIE_MODEL?.trim();
const wantsFree = wanted === `group/${FREE_GROUP}`;
const missesFree = wantsFree ? !ids.includes(wanted) : ids.length === 0;
if (missesFree && env.MAGPIE_START !== '0') {
	const tool = reachable.binary ?? findMagpieBinary(env, [join(ourBinDir, 'magpie')]);
	if (tool) {
		await ensureFreeRoute({ binary: tool, log });
		ids = (await listModels(config)).map((model) => model.id);
	}
}

// An empty model name fails much later and much less clearly: say what to do
// while the user is still looking.
if (wanted && !ids.includes(wanted)) {
	console.error(`[bot] magpie has no model "${wanted}"`);
	if (!ids.some((id) => id.startsWith(FREE_MODEL_PREFIX))) {
		// The plugin brings the pool, but the pool is behind one browser step:
		// its console, where a channel is authorized. That is the only thing
		// this product cannot do for the user.
		console.error('[bot] the free pool needs its console opened once, in a browser:');
		console.error('[bot]   magpie plugin login our-free-model');
		console.error('[bot] open the address it prints, authorize a channel, then start this again');
	} else {
		console.error('[bot] the free route has to be created once:');
		console.error(`[bot]   magpie plugin add ${FREE_PLUGIN}`);
		console.error(`[bot]   magpie group add ${FREE_GROUP} 'models=our-free-model/*' routing=smart`);
	}
	console.error(`[bot] available now: ${ids.slice(0, 12).join(', ') || '(nothing)'}${ids.length > 12 ? ', …' : ''}`);
	process.exit(1);
}

const bot = await Bot.open({
	dataDir,
	config,
	modelId: env.MAGPIE_MODEL,
	workspaceDir: env.WORKSPACE_DIR ? resolve(env.WORKSPACE_DIR) : undefined,
});

const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
const webDisabled = env.WEB_PORT === '0';
const owners = bot.owners;

const shutdown: Array<() => Promise<void> | void> = [];

if (telegramToken) {
	const telegram = new TelegramChannel({
		token: telegramToken,
		owners,
		apiBase: env.TELEGRAM_API_BASE,
		onMessage: (event) => {
			bot.ingest(event);
		},
	});
	bot.register(telegram);
	telegram.start();
	shutdown.push(() => telegram.stop());
	console.log('[bot] telegram is listening');
} else {
	console.log('[bot] no TELEGRAM_BOT_TOKEN, so telegram is off');
}

if (!webDisabled) {
	const web = new WebChannel({
		port: Number(env.WEB_PORT ?? 8787),
		host: env.WEB_HOST ?? '127.0.0.1',
		password: env.WEB_PASSWORD,
		// A reopened tab gets the conversation back instead of an empty page.
		history: (target) => bot.transcript('web', target),
		onMessage: (event) => {
			bot.ingest(event);
		},
	});
	bot.register(web);
	const { url } = await web.start();
	shutdown.push(() => web.stop());
	console.log(`[bot] web chat at ${url}${env.WEB_PASSWORD ? ' (password required)' : ''}`);
}

if (shutdown.length === 0) {
	console.error('[bot] nothing to talk to: set TELEGRAM_BOT_TOKEN or leave WEB_PORT on');
	await bot.close();
	process.exit(1);
}

const stopLoop = bot.start(Number(env.TICK_MS ?? 2_000));
console.log(`[bot] model ${env.MAGPIE_MODEL ?? 'auto-picked'} via ${config.baseUrl}`);

let closing = false;
const close = async (signal: string) => {
	if (closing) return;
	closing = true;
	console.log(`[bot] ${signal}, stopping`);
	stopLoop();
	for (const stop of shutdown) await stop();
	await bot.close();
	process.exit(0);
};

process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('[bot] unhandled rejection', error));
