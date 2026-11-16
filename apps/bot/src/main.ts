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
import { serveSetupPage, type SetupPageOptions, WebChannel } from '@pi-magpie-bot/channel-web';
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
/** How to reach magpie's own CLI: here, or in the container that runs it. */
const remoteGateway = env.MAGPIE_START === '0';
const magpieCli = remoteGateway ? 'docker compose -f deploy/docker-compose.yml exec magpie /magpie' : 'magpie';

/**
 * A setup step that only a person can take is a state, not a crash: the reason
 * goes to the terminal and to a page, and the process stays up. Under
 * `docker compose` the alternative is a container restarting forever with the
 * answer buried in its log. Never returns.
 */
async function needsSetup(options: SetupPageOptions & { console?: string[] }): Promise<never> {
	const { console: lines = [], ...page } = options;
	for (const line of lines) console.error(`[bot] ${line}`);
	if (env.WEB_PORT === '0') process.exit(1);
	const url = await serveSetupPage({
		...page,
		host: env.WEB_HOST ?? '127.0.0.1',
		port: Number(env.WEB_PORT ?? 8787),
	});
	console.error(`[bot] a page saying this is at ${url}`);
	return await new Promise<never>(() => {});
}

/**
 * A gateway that is down is started or waited for; one that answers with a
 * refusal is not down at all, so send the user to the key instead of a timeout.
 */
async function models(): Promise<{ ids: string[]; binary?: string }> {
	try {
		return { ids: (await listModels(config)).map((model) => model.id) };
	} catch (error) {
		if (/\b(401|403|429)\b/.test(String(error))) {
			return await needsSetup({
				title: '还不能聊天：magpie 不接受这个网关密钥',
				reason:
					'网关跑在另一台机器或另一个容器里时，它要求一把自己的 key；新起的容器里一把都没有，所以它拒绝了这一次请求。',
				steps: [
					{
						command: `${magpieCli} gateway-key add bot`,
						note: '把打印出来的 sk-magpie-key-… 填进 .env 的 MAGPIE_API_KEY。',
					},
					{
						command: remoteGateway ? 'docker compose -f deploy/docker-compose.yml up -d' : 'pnpm start',
						note: '改完 .env 要重新起一次才生效。',
					},
				],
				docsUrl: 'https://github.com/mazihua-lgtm/pi-magpie-bot#云端--cloud',
				console: [
					'magpie refused this gateway key',
					'a shared gateway has its own keys; make one and put it in .env as MAGPIE_API_KEY:',
					`  ${magpieCli} gateway-key add bot`,
				],
			});
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

// No model is a first-run state, not a crash: say what is missing, and keep a
// page up saying it, because whoever started this from a compose file has no
// terminal to read.
const modelOk = wanted ? ids.includes(wanted) : ids.length > 0;
if (!modelOk) {
	// The free plugin brings the pool, but the pool sits behind one browser
	// step, its console. That much this product cannot do for someone.
	const waitingForConsole = !ids.some((id) => id.startsWith(FREE_MODEL_PREFIX));
	await needsSetup({
		title: '还不能聊天：magpie 里没有能用的模型',
		reason: waitingForConsole
			? '免费模型插件装上了，但它手里还没有模型：要在浏览器里打开它的控制台授权一次，那一步只能由人来做。'
			: '网关里现在没有这个模型。',
		steps: waitingForConsole
			? [
					{ command: `${magpieCli} plugin login our-free-model`, note: '在浏览器里打开它打印的地址，按页面提示授权，然后回来重启。' },
					{ command: `${magpieCli} provider add deepseek sk-…`, note: '不想走免费池就填自己的 key（magpie presets 看厂商代号）。' },
				]
			: [
					{ command: `${magpieCli} group add ${FREE_GROUP} 'models=our-free-model/*' routing=smart`, note: '把免费模型放进路由组。' },
					{ command: `${magpieCli} provider add deepseek sk-…`, note: '或者填自己的 key。' },
				],
		docsUrl: 'https://github.com/mazihua-lgtm/pi-magpie-bot/blob/main/docs/own-models.md',
		console: [
			wanted ? `magpie has no model "${wanted}"` : 'magpie has no models at all',
			...(waitingForConsole
				? [
						'the free pool needs its console opened once, in a browser:',
						`  ${magpieCli} plugin login our-free-model`,
						'open the address it prints, authorize a channel, then start this again',
					]
				: [
						'the free route has to be created once:',
						`  ${magpieCli} plugin add ${FREE_PLUGIN}`,
						`  ${magpieCli} group add ${FREE_GROUP} 'models=our-free-model/*' routing=smart`,
					]),
			`available now: ${ids.slice(0, 12).join(', ') || '(nothing)'}${ids.length > 12 ? ', …' : ''}`,
		],
	});
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
