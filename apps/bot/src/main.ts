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
import { AppService, Bot } from '@pi-magpie-bot/brain';
import { clearDataDirLock } from '@pi-magpie-bot/events';
import { serveSetupPage, type SetupPageOptions, WebChannel } from '@pi-magpie-bot/channel-web';
import {
	addProvider,
	ensureFreeRoute,
	ensureGateway,
	ensureOfmRoute,
	findMagpieBinary,
	FREE_GROUP,
	FREE_MODEL_PREFIX,
	FREE_PLUGIN,
	gatewayConfig,
	hasConfiguredModel,
	installMagpie,
	listModels,
} from '@pi-magpie-bot/gateway';
import { VENDORS } from './vendors.ts';

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

// Registered before anything is awaited: the startup below awaits at the top
// level, and a rejection there is not caught by anything else in this file.
// Without these two, a port already in use or a failed download kills the
// process with a stack trace and the restart loop never says why.
process.on('unhandledRejection', (error) => {
	console.error('[bot] unhandled rejection', error);
});
process.on('uncaughtException', (error) => {
	console.error('[bot] uncaught exception', error);
});

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
const magpieCli = remoteGateway ? 'docker compose exec magpie /magpie' : 'magpie';
/** Which model the user asked for, and whether that means the free pool. */
const wanted = env.MAGPIE_MODEL?.trim();
/** Every name the free route answers to: the old group, and the proxy's model. */
const FREE_IDS = [`group/${FREE_GROUP}`, 'group/ofm-free', 'ofm/free'];
const wantsFree = wanted !== undefined && FREE_IDS.includes(wanted);

/**
 * The local free-model service. The Android payload bundles a slimmed copy at
 * /opt/ofm; a desktop can point OFM_SOURCE at one it installed. Absent either,
 * this is a normal install and the older plugin route is used instead.
 */
const ofmSource = env.OFM_SOURCE?.trim();
const ofmDataDir = join(dataDir, 'ofm');

/** magpie's own CLI, fetched and checked if this machine has none. */
async function magpieBinary(): Promise<string | undefined> {
	const found = findMagpieBinary(env, [join(ourBinDir, 'magpie')]);
	if (found) return found;
	try {
		return await installMagpie({ dir: ourBinDir, log });
	} catch (error) {
		log(`magpie did not install: ${(error as Error).message.split('\n')[0]}`);
		return undefined;
	}
}

/** Saves the key the first-run page took. It never comes back out of here. */
async function saveKey(input: { preset: string; key: string }): Promise<string> {
	const binary = findMagpieBinary(env, [join(ourBinDir, 'magpie')]) ?? (await magpieBinary());
	if (!binary) throw new Error('这台机器上没有 magpie，先跑一次 ./install.sh 再试。');
	await addProvider({ binary, preset: input.preset, key: input.key });
	return '加进 magpie 了，正在启动，等几秒刷新这一页。';
}

/**
 * The key box needs a magpie of this machine's own to talk to. Under compose the
 * bot container only speaks HTTP to the gateway container, so that page keeps
 * to the commands — which there are run with `docker compose exec`.
 */
function canSaveKey(): boolean {
	return env.MAGPIE_START !== '0' || Boolean(findMagpieBinary(env, [join(ourBinDir, 'magpie')]));
}

/**
 * A setup step that only a person can take is a state, not a crash: the reason
 * goes to the terminal and to a page, and the process stays up. Under
 * `docker compose` the alternative is a container restarting forever with the
 * answer buried in its log. It comes back only when the page took a key.
 */
async function needsSetup(options: SetupPageOptions & { console?: string[] }): Promise<'retry'> {
	const { console: lines = [], ...page } = options;
	for (const line of lines) console.error(`[bot] ${line}`);
	if (env.WEB_PORT === '0') process.exit(1);
	const webHost = env.WEB_HOST ?? '127.0.0.1';
	// A page other machines can open takes a key only behind the password.
	const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(webHost);
	const { url, fixed } = await serveSetupPage({
		...page,
		presets: VENDORS,
		...(canSaveKey() && (loopbackHost || env.WEB_PASSWORD) ? { onKey: saveKey, password: env.WEB_PASSWORD || undefined } : {}),
		host: webHost,
		port: Number(env.WEB_PORT ?? 8787),
	});
	console.error(`[bot] a page saying this is at ${url}`);
	await fixed;
	return 'retry';
}

/** What the startup model check ended up with, or a word that the page fixed it. */
type Look = { ids: string[]; binary?: string } | 'retry';

/**
 * A gateway that is down is started or waited for; one that answers with a
 * refusal is not down at all, so send the user to the key instead of a timeout.
 */
async function models(): Promise<Look> {
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
						command: remoteGateway ? 'docker compose up -d' : 'pnpm start',
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
		const start = env.MAGPIE_START !== '0';
		// The free pool is signed up before anything listens. Not politeness:
		// magpie's sign-in asks the running gateway for its management page and
		// is refused, so it only works while no magpie is up. That sign-in takes
		// minutes; check first whether a provider is already configured, or a
		// phone that has a working model still waits three minutes on every boot.
		let binary: string | undefined;
		if (start) {
			binary = await magpieBinary();
			if (binary && ofmSource) {
				// Unconditional: the local service and its proxy are processes, not
				// just config, and a reboot leaves the config but not the running
				// processes. It is idempotent - it starts only what is down - and a
				// user who picked their own model still wants the free one available
				// rather than a dead provider in the list.
				await ensureOfmRoute({ binary, node: process.execPath, sourceDir: ofmSource, dataDir: ofmDataDir, log });
			} else if (wantsFree || !wanted) {
				// The older plugin route, for a machine with no bundled service.
				// Its sign-in is slow, so a machine that already has a model skips it.
				const configured = wanted ? undefined : binary ? await hasConfiguredModel(binary) : undefined;
				if (configured === true) log('a provider is already configured; leaving the free pool alone');
				else if (binary) await ensureFreeRoute({ binary, log });
			}
		}
		const started = await ensureGateway(config, { start, installDir: ourBinDir, binary, log });
		return { ids: (await listModels(config)).map((model) => model.id), binary: started.binary ?? binary };
	}
}

/**
 * Everything that has to be true before the bot can open: a gateway that
 * answers, a model this bot is allowed to use, and — when the pool gives
 * nothing — a page that takes a key instead of commands. `'retry'` means the
 * page took one, so the check is worth running again against the new pool.
 */
async function startupModels(): Promise<Look> {
	const reachable = await models();
	if (reachable === 'retry') return 'retry';
	let ids = reachable.ids;

	// The free route answers to more than one name across versions: an old
	// `.env` says group/free, the bundled proxy registers ofm/free. Treat them
	// as the same wish, or a stale default leaves a working model unused and
	// drops the user on the "no model" page.
	const askedFree = wanted !== undefined && FREE_IDS.includes(wanted);
	const freeHere = () => FREE_IDS.find((id) => ids.includes(id));
	const resolved = () => (askedFree ? freeHere() : wanted);

	// A gateway someone else started (Homebrew, a desktop app) has no routing
	// groups either. Same two commands, run here; a gateway already filled with
	// the user's own models is left alone.
	const first = resolved();
	const missesFree = first === undefined ? ids.length === 0 : !ids.includes(first);
	if (missesFree && env.MAGPIE_START !== '0' && !ofmSource) {
		const tool = reachable.binary ?? findMagpieBinary(env, [join(ourBinDir, 'magpie')]);
		if (tool) {
			await ensureFreeRoute({ binary: tool, log });
			ids = (await listModels(config)).map((model) => model.id);
		}
	}

	// No model is a first-run state, not a crash: say what is missing, and keep a
	// page up saying it, because whoever started this from a compose file has no
	// terminal to read. Someone who asked for the free model and has none is not
	// quietly handed a different one.
	const chosen = resolved();
	// Wanted a free model and there is none: not OK, even if paid models exist —
	// silently answering on a paid model is a bill the user did not ask for.
	const modelOk = askedFree ? chosen !== undefined : chosen !== undefined ? ids.includes(chosen) : ids.length > 0;
	if (modelOk) return { ids, binary: reachable.binary };

	// The anonymous pool signs itself up, so getting nothing back means the
	// upstream gave nothing to this address: out of quota, or it wants a channel
	// added through its console — the one step a person has to do.
	const poolEmpty = !ids.some((id) => id.startsWith(FREE_MODEL_PREFIX));
	return await needsSetup({
		// Plain words: this page is the first thing a phone user sees when the
		// free models did not come through, and "magpie", "网关" and "渠道" mean
		// nothing to them. The commands below are for whoever has a terminal.
		title: '还不能聊天：还没有能用的模型',
		reason: poolEmpty
			? '免费额度这次没发下来。你也可以用自己的账号：选一家，把它的密钥粘进来，马上就能用。'
			: '现在没有这个模型。你也可以用自己的账号：选一家，把它的密钥粘进来。',
		steps: poolEmpty
			? [
					{
						command: `${magpieCli} plugin login our-free-model`,
						note: '先停掉 magpie 再运行；打开它打印的地址，按页面提示接一个渠道，然后重新起 bot。',
					},
					{ command: `${magpieCli} provider add deepseek sk-…`, note: '不想等免费池就填自己的 key（magpie presets 看厂商代号）。' },
				]
			: [
					{ command: `${magpieCli} group add ${FREE_GROUP} 'models=our-free-model/*' routing=smart`, note: '把免费模型放进路由组。' },
					{ command: `${magpieCli} provider add deepseek sk-…`, note: '或者填自己的 key。' },
				],
		docsUrl: 'https://github.com/mazihua-lgtm/pi-magpie-bot/blob/main/docs/own-models.md',
		console: [
			wanted ? `magpie has no model "${wanted}"` : 'magpie has no models at all',
			...(poolEmpty
				? [
						'the free pool gave no models: the quota for this address may be used up,',
						'or it wants a channel added in its console:',
						`  ${magpieCli} plugin login our-free-model`,
						'stop magpie first, open the address it prints, add a channel, start this again',
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

// The page can fix this without a restart, so it is allowed to answer more than
// once; three tries is enough for a key that turns out not to work.
let reachable: Look = 'retry';
try {
	for (let attempt = 0; attempt < 3 && reachable === 'retry'; attempt += 1) {
		reachable = await startupModels();
	}
} catch (error) {
	// No network to fetch magpie, or a gateway that never came up: say so in a
	// line instead of a stack trace. A service manager (or Docker's restart
	// policy) starts this again, which is the right answer to a network that
	// was away for a minute.
	const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
	console.error(`[bot] the model gateway is not ready: ${reason}`);
	console.error(
		env.MAGPIE_START === '0'
			? '[bot] check that the gateway is running and MAGPIE_BASE_URL points at it; stopping so it can be started again'
			: '[bot] check that this machine can reach github.com; stopping so it can be started again',
	);
	process.exit(1);
}
if (reachable === 'retry') {
	console.error('[bot] no model even after a key was saved; stopping');
	process.exit(1);
}

/** Whether a chat is already answering on our own web port. */
async function serving(): Promise<boolean> {
	if (env.WEB_PORT === '0') return true; // No web chat to ask; assume the holder is real.
	try {
		const response = await fetch(`http://127.0.0.1:${env.WEB_PORT ?? 8787}/healthz`, {
			signal: AbortSignal.timeout(2_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function openBot(): Promise<Bot> {
	try {
		return await Bot.open({
			dataDir,
			config,
			modelId: env.MAGPIE_MODEL,
			workspaceDir: env.WORKSPACE_DIR ? resolve(env.WORKSPACE_DIR) : undefined,
		});
	} catch (error) {
		// A process can be alive and holding the directory while serving nobody -
		// a hung run, a half-dead proot. Refusing forever would be worse than the
		// mistake the lock exists to prevent, so check before giving up.
		if (!/另一个助理|another assistant/.test((error as Error).message)) throw error;
		if (await serving()) {
			console.error('[bot] 已经有一个助理在跑了，而且正在应答。直接用它就行，不用再起一个。');
			process.exit(0);
		}
		console.error('[bot] 数据目录被一个不再应答的进程占着，正在接管。');
		clearDataDirLock(dataDir);
		return await Bot.open({
			dataDir,
			config,
			modelId: env.MAGPIE_MODEL,
			workspaceDir: env.WORKSPACE_DIR ? resolve(env.WORKSPACE_DIR) : undefined,
		});
	}
}

const bot = await openBot();

const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim();
const webDisabled = env.WEB_PORT === '0';
const owners = bot.owners;

const shutdown: Array<() => Promise<void> | void> = [];

if (telegramToken) {
	// Loaded on demand: the Android payload ships without these channels' SDKs,
	// so a static import would crash before the web chat could even open. A user
	// who set the token has the packages; one who did not never loads them.
	const { TelegramChannel } = await import('@pi-magpie-bot/channel-telegram');
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

const feishuId = env.FEISHU_APP_ID?.trim();
const feishuSecret = env.FEISHU_APP_SECRET?.trim();
if (feishuId && feishuSecret) {
	const { FeishuChannel } = await import('@pi-magpie-bot/channel-feishu');
	const feishu = new FeishuChannel({
		appId: feishuId,
		appSecret: feishuSecret,
		domain: env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu',
		owners,
		onMessage: (event) => {
			bot.ingest(event);
		},
	});
	bot.register(feishu);
	// Whether it really connected is said by the channel itself ("[feishu] connected").
	feishu.start().catch((error: unknown) => console.error('[bot] feishu failed to start:', error instanceof Error ? error.message : error));
	console.log('[bot] feishu is starting');
	shutdown.push(() => feishu.stop());
} else if (feishuId || feishuSecret) {
	console.warn('[bot] feishu needs both FEISHU_APP_ID and FEISHU_APP_SECRET, so it is off');
}

const wecomId = env.WECOM_BOT_ID?.trim();
const wecomSecret = env.WECOM_BOT_SECRET?.trim();
if (wecomId && wecomSecret) {
	const { WecomChannel } = await import('@pi-magpie-bot/channel-wecom');
	const wecom = new WecomChannel({
		botId: wecomId,
		secret: wecomSecret,
		owners,
		onMessage: (event) => {
			bot.ingest(event);
		},
	});
	bot.register(wecom);
	wecom.start();
	shutdown.push(() => wecom.stop());
	// Whether it really connected is said by the channel itself ("[wecom] connected").
	console.log('[bot] wecom is starting');
} else if (wecomId || wecomSecret) {
	console.warn('[bot] wecom needs both WECOM_BOT_ID and WECOM_BOT_SECRET, so it is off');
}

if (!webDisabled) {
	const webHost = env.WEB_HOST ?? '127.0.0.1';
	if (!env.WEB_PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(webHost)) {
		console.warn(
			`[bot] ! the web chat listens on ${webHost} with no WEB_PASSWORD: whoever can reach this port can use the assistant. Set WEB_PASSWORD, or keep the port to this machine.`,
		);
	}
	const web = new WebChannel({
		port: Number(env.WEB_PORT ?? 8787),
		host: webHost,
		password: env.WEB_PASSWORD,
		// Kept in the host tables: a secret that only lives in memory signs every
		// phone out at every restart, update or reboot.
		secret: {
			get: () => bot.kv.get('web-cookie-secret'),
			set: (value) => bot.kv.set('web-cookie-secret', value),
		},
		// A reopened tab gets the conversation back instead of an empty page.
		history: (target) => bot.transcript('web', target),
		// The native app's API. A key it saves is loaded by starting again: the
		// Android service brings the process back in seconds.
		app: new AppService(bot, {
			vendors: VENDORS.map((vendor) => ({ preset: vendor.id, name: vendor.name, signupUrl: vendor.signup })),
			// Same rule as the first-run page: a page others can reach takes a key
			// only behind the password.
			...(canSaveKey() && (['127.0.0.1', 'localhost', '::1'].includes(webHost) || env.WEB_PASSWORD)
				? {
						saveProvider: async (input: { preset: string; key: string }) => {
							await saveKey(input);
							return '加好了。助理正在重启载入新模型，几秒后就能用。';
						},
					}
				: {}),
			restart: () => void close('a model key was added, restarting'),
		}),
		onMessage: (event) => {
			bot.ingest(event);
		},
	});
	bot.register(web);
	let url: string;
	try {
		({ url } = await web.start());
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EADDRINUSE') {
			// The common cause is our own previous run not having died, and that
			// process is still answering people. Say so instead of restarting
			// forever with a stack trace nobody sees on a phone.
			console.error(
				`[bot] 端口 ${env.WEB_PORT ?? 8787} 已经被占用了：很可能已经有一个助理在跑。先把它关掉，或者换一个 WEB_PORT。`,
			);
			console.error(`[bot] port ${env.WEB_PORT ?? 8787} is already in use by another process; stop it or set WEB_PORT`);
			await bot.close();
			process.exit(1);
		}
		throw error;
	}
	shutdown.push(() => web.stop());
	console.log(`[bot] web chat at ${url}${env.WEB_PASSWORD ? ' (password required)' : ''}`);
}

if (shutdown.length === 0) {
	console.error('[bot] nothing to talk to: set TELEGRAM_BOT_TOKEN, FEISHU_APP_ID and FEISHU_APP_SECRET, WECOM_BOT_ID and WECOM_BOT_SECRET, or leave WEB_PORT on');
	await bot.close();
	process.exit(1);
}

// Work arrives through wake(); this number is only the fallback tick that
// covers retries coming due and anything that bypasses wake. A tiny value here
// would just spin the passes against empty tables.
const idle = Number(env.TICK_MS ?? 30_000);
const stopLoop = bot.start(Number.isFinite(idle) && idle >= 1_000 ? idle : 30_000);
console.log(`[bot] model ${env.MAGPIE_MODEL ?? 'auto-picked'} via ${config.baseUrl}`);

let closing = false;
async function close(signal: string): Promise<void> {
	if (closing) return;
	closing = true;
	console.log(`[bot] ${signal}, stopping`);
	stopLoop();
	for (const stop of shutdown) await stop();
	await bot.close();
	process.exit(0);
}

process.on('SIGINT', () => void close('SIGINT'));
process.on('SIGTERM', () => void close('SIGTERM'));
