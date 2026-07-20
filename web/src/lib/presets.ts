// Built-in model provider presets for the settings page.
// Source: wayfinder R01 research (.wayfinder/research/preset-providers.md),
// authoritative from the installed pi-ai SDK provider factories.
//
// Presets have a FIXED baseUrl baked into the SDK — the settings page does NOT
// expose a baseUrl field for these; only an API key (+ optional model picker).
// Custom (non-builtin) providers, which DO need a baseUrl + registerProvider,
// are added separately in the drawer.

export type PresetProvider = {
  id: string; // SDK providerId
  name: string; // display name
  defaultBaseUrl: string; // informational (not user-editable for presets)
  authType: "api_key" | "api_key+oauth" | "oauth";
  exampleModelId: string;
  envVar?: string; // env fallback label for the key field
  region?: "cn"; // China mirror
  notes?: string;
};

// Mainstream international first, then China-friendly mirrors, then
// aggregators/specialty. See R01 for full table.
export const PRESET_PROVIDERS: PresetProvider[] = [
  { id: "anthropic", name: "Anthropic", defaultBaseUrl: "https://api.anthropic.com", authType: "api_key+oauth", exampleModelId: "claude-fable-5", envVar: "ANTHROPIC_API_KEY", notes: "Also Claude Pro/Max OAuth" },
  { id: "openai", name: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", authType: "api_key", exampleModelId: "gpt-4", envVar: "OPENAI_API_KEY" },
  { id: "google", name: "Google (Gemini)", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", authType: "api_key", exampleModelId: "gemini-2.0-flash", envVar: "GEMINI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com", authType: "api_key", exampleModelId: "deepseek-v4-flash", envVar: "DEEPSEEK_API_KEY" },
  { id: "xai", name: "xAI", defaultBaseUrl: "https://api.x.ai/v1", authType: "api_key+oauth", exampleModelId: "grok-4.3", envVar: "XAI_API_KEY", notes: "Also OAuth" },
  { id: "mistral", name: "Mistral", defaultBaseUrl: "https://api.mistral.ai", authType: "api_key", exampleModelId: "codestral-latest", envVar: "MISTRAL_API_KEY" },
  { id: "openrouter", name: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", authType: "api_key", exampleModelId: "ai21/jamba-large-1.7", envVar: "OPENROUTER_API_KEY", notes: "Aggregator" },
  { id: "groq", name: "Groq", defaultBaseUrl: "https://api.groq.com/openai/v1", authType: "api_key", exampleModelId: "llama-3.1-8b-instant", envVar: "GROQ_API_KEY" },
  { id: "together", name: "Together", defaultBaseUrl: "https://api.together.ai/v1", authType: "api_key", exampleModelId: "MiniMaxAI/MiniMax-M2.7", envVar: "TOGETHER_API_KEY" },
  { id: "fireworks", name: "Fireworks", defaultBaseUrl: "https://api.fireworks.ai/inference", authType: "api_key", exampleModelId: "accounts/fireworks/models/deepseek-v4-flash", envVar: "FIREWORKS_API_KEY" },
  { id: "cerebras", name: "Cerebras", defaultBaseUrl: "https://api.cerebras.ai/v1", authType: "api_key", exampleModelId: "gemma-4-31b", envVar: "CEREBRAS_API_KEY" },
  { id: "moonshotai", name: "Moonshot AI", defaultBaseUrl: "https://api.moonshot.ai/v1", authType: "api_key", exampleModelId: "kimi-k2-0711-preview", envVar: "MOONSHOT_API_KEY" },
  { id: "moonshotai-cn", name: "Moonshot AI (CN)", defaultBaseUrl: "https://api.moonshot.cn/v1", authType: "api_key", exampleModelId: "kimi-k2-0711-preview", envVar: "MOONSHOT_API_KEY", region: "cn" },
  { id: "minimax", name: "MiniMax", defaultBaseUrl: "https://api.minimax.io/anthropic", authType: "api_key", exampleModelId: "MiniMax-M2.7", envVar: "MINIMAX_API_KEY" },
  { id: "minimax-cn", name: "MiniMax (CN)", defaultBaseUrl: "https://api.minimaxi.com/anthropic", authType: "api_key", exampleModelId: "MiniMax-M2.7", envVar: "MINIMAX_CN_API_KEY", region: "cn" },
  { id: "kimi-coding", name: "Kimi For Coding", defaultBaseUrl: "https://api.kimi.com/coding", authType: "api_key", exampleModelId: "k2p7", envVar: "KIMI_API_KEY" },
  { id: "zai", name: "Z.AI (GLM)", defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4", authType: "api_key", exampleModelId: "glm-4.5-air", envVar: "ZAI_API_KEY", notes: "Zhipu GLM, intl" },
  { id: "zai-coding-cn", name: "Z.AI Coding CN (GLM / 智谱)", defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", authType: "api_key", exampleModelId: "glm-4.5-air", envVar: "ZAI_CODING_CN_API_KEY", region: "cn", notes: "The GLM preset (bigmodel.cn = 智谱)" },
  { id: "ant-ling", name: "Ant Ling", defaultBaseUrl: "https://api.ant-ling.com/v1", authType: "api_key", exampleModelId: "Ling-2.6-1T", envVar: "ANT_LING_API_KEY", notes: "Ant Group Ling" },
  { id: "nvidia", name: "NVIDIA", defaultBaseUrl: "https://integrate.api.nvidia.com/v1", authType: "api_key", exampleModelId: "meta/llama-3.1-70b-instruct", envVar: "NVIDIA_API_KEY" },
  { id: "huggingface", name: "Hugging Face", defaultBaseUrl: "https://router.huggingface.co/v1", authType: "api_key", exampleModelId: "MiniMaxAI/MiniMax-M2", envVar: "HF_TOKEN" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", defaultBaseUrl: "https://ai-gateway.vercel.sh", authType: "api_key", exampleModelId: "", envVar: "AI_GATEWAY_API_KEY" },
];

export const PRESET_BY_ID = new Map(PRESET_PROVIDERS.map((p) => [p.id, p]));
