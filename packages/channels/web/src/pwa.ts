/**
 * What makes the chat page installable on a phone: a manifest, three icons and
 * an empty service worker. Chrome on Android only offers "add to home screen"
 * when a service worker with a fetch handler exists; the handler does nothing,
 * because the page is short and must always be fresh.
 */
import { readFileSync } from 'node:fs';

export const MANIFEST = JSON.stringify({
	name: '喜鹊',
	short_name: '喜鹊',
	description: '一个常驻的私人助理：记得你说过的话，到点提醒你。',
	lang: 'zh-CN',
	start_url: '/',
	scope: '/',
	display: 'standalone',
	background_color: '#2f7cf6',
	theme_color: '#2f7cf6',
	icons: [
		{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
		{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
	],
});

export const SERVICE_WORKER = `// No cache: an assistant that answers from a stale page is worse than a slow one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;

/** Read once at startup: they are small and never change while the bot runs. */
export const ICONS: Record<string, Buffer> = {
	'/icon-192.png': readFileSync(new URL('./icon-192.png', import.meta.url)),
	'/icon-512.png': readFileSync(new URL('./icon-512.png', import.meta.url)),
	'/apple-touch-icon.png': readFileSync(new URL('./apple-touch-icon.png', import.meta.url)),
};
