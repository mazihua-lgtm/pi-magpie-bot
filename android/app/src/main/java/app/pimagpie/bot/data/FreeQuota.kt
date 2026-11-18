package app.pimagpie.bot.data

/**
 * Where a free allowance comes from when the free pool is queued or dry.
 *
 * The preset is magpie's own, checked against `magpie presets`, so a row can
 * open the key sheet by itself even though the first-run vendor list stays
 * short. Notes stay vague on purpose: quotas change, and a number written into
 * an APK is a number that is wrong six weeks later.
 */
object FreeQuota {
	data class Entry(
		val preset: String,
		val name: String,
		val note: String,
		/** Where a person with no key goes to get one. */
		val signup: String,
		/** Whether it is reachable without a proxy from the mainland. */
		val direct: Boolean,
	)

	val entries = listOf(
		Entry("zhipu", "智谱 GLM", "有几款长期免费的 Flash 型号，额度和范围以官网为准", "https://open.bigmodel.cn", direct = true),
		Entry("qwen-cn", "阿里云百炼", "新用户每个模型送一批免费 token，日常聊天够用", "https://bailian.console.aliyun.com", direct = true),
		Entry("siliconflow", "硅基流动", "注册送额度，也有几个免费小模型", "https://cloud.siliconflow.cn", direct = true),
		Entry("modelscope", "魔搭 ModelScope", "每天有免费调用额度，国内直连", "https://modelscope.cn", direct = true),
		Entry("google", "Google AI Studio", "Gemini 的免费额度，个人用足够", "https://aistudio.google.com", direct = false),
		Entry("groq", "Groq", "免费额度，出字快，适合小模型", "https://console.groq.com", direct = false),
		Entry("openrouter", "OpenRouter", "带 :free 后缀的模型不花钱", "https://openrouter.ai", direct = false),
	)
}
