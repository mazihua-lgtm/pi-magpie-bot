/**
 * The vendors the first-run page names. Short on purpose: someone with a vendor
 * this list misses still has the command underneath it, and a wall of twenty
 * choices is what the page is trying to spare them.
 *
 * `signup` is where a person with no key goes to get one. A vendor that pays
 * the project for people who sign up through its link gets `sponsored: true`
 * and that link in `signup`; the page then says so next to the link. Nothing
 * else about the list changes, and no vendor is pre-selected.
 */
export interface Vendor {
	/** The magpie preset id. */
	id: string;
	name: string;
	signup?: string;
	sponsored?: boolean;
}

export const VENDORS: Vendor[] = [
	{ id: 'deepseek', name: 'DeepSeek', signup: 'https://platform.deepseek.com' },
	{ id: 'moonshot-cn', name: 'Kimi（国内站）', signup: 'https://platform.moonshot.cn' },
	{ id: 'zhipu', name: '智谱 GLM', signup: 'https://open.bigmodel.cn' },
	{ id: 'qwen-cn', name: '通义千问（国内站）', signup: 'https://bailian.console.aliyun.com' },
	{ id: 'openai', name: 'OpenAI', signup: 'https://platform.openai.com' },
	{ id: 'anthropic', name: 'Anthropic', signup: 'https://console.anthropic.com' },
	{ id: 'google', name: 'Google Gemini', signup: 'https://aistudio.google.com' },
	{ id: 'xai', name: 'xAI', signup: 'https://console.x.ai' },
];
