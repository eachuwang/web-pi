# Preset Model Providers — web-pi Settings Page

Source of truth: installed SDK `@earendil-works/pi-coding-agent` → bundled `@earendil-works/pi-ai` (under `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/`). Each provider factory (`createProvider({...})`) declares `id`, `name`, `baseUrl`, and an `auth` block.

The GitHub repo (https://github.com/earendil-works/pi) could not be fetched from this sandbox (domain blocked); the installed dist is authoritative and matches the repo's published `packages/ai/src/providers`.

## How auth works (matters for the settings page)

- `envApiKeyAuth(label, [ENV_VAR])` — API-key provider. The user supplies a key; the SDK also checks the listed env var as a fallback. **This is the common case** and the one the "preset providers" list targets: user just pastes a key, no `baseUrl` needed.
- `oauth` block (`lazyOAuth({...})`) — login flow, not a pasted key. Providers: `anthropic` (Claude Pro/Max), `xai`, `github-copilot`, `openai-codex` (ChatGPT Plus/Pro). These need a login button, not a key field. Some (`anthropic`, `xai`, `github-copilot`) support **both** api_key and oauth.
- Cloud-credential providers (`google-vertex`, `amazon-bedrock`, `cloudflare-*`, `azure-openai-responses`) have no static `baseUrl` and use ambient cloud auth (ADC / AWS profile / Azure key). Not suitable for a simple "paste key" preset — skip or hide behind an advanced section.
- `openai-codex` is **oauth-only** (no api_key path) — special: must be a login button, not a key field.
- `opencode` / `opencode-go` have no static `baseUrl` (per-model baseUrls in their catalog) — api_key only, but baseUrl-less; not a clean "preset".

## Preset providers table (api_key-first)

Recommended rows for the settings page "preset providers" picker. Sort: mainstream international first, then China-friendly mirrors, then aggregators/specialty.

| id | name | defaultBaseUrl | authType | exampleModelId | notes |
|---|---|---|---|---|---|
| anthropic | Anthropic | https://api.anthropic.com | api_key (+oauth) | claude-fable-5 | Also supports Claude Pro/Max OAuth login. Env fallback `ANTHROPIC_API_KEY` / `ANTHROPIC_OAUTH_TOKEN`. |
| openai | OpenAI | https://api.openai.com/v1 | api_key | gpt-4 | Env fallback `OPENAI_API_KEY`. |
| google | Google (Gemini) | https://generativelanguage.googleapis.com/v1beta | api_key | gemini-2.0-flash | Env fallback `GEMINI_API_KEY`. |
| deepseek | DeepSeek | https://api.deepseek.com | api_key | deepseek-v4-flash | Env fallback `DEEPSEEK_API_KEY`. |
| xai | xAI | https://api.x.ai/v1 | api_key (+oauth) | grok-4.3 | Also supports OAuth. Env fallback `XAI_API_KEY`. |
| mistral | Mistral | https://api.mistral.ai | api_key | codestral-latest | Env fallback `MISTRAL_API_KEY`. |
| openrouter | OpenRouter | https://openrouter.ai/api/v1 | api_key | ai21/jamba-large-1.7 | Aggregator; one key unlocks many models. Env fallback `OPENROUTER_API_KEY`. |
| groq | Groq | https://api.groq.com/openai/v1 | api_key | llama-3.1-8b-instant | Env fallback `GROQ_API_KEY`. |
| together | Together | https://api.together.ai/v1 | api_key | MiniMaxAI/MiniMax-M2.7 | Env fallback `TOGETHER_API_KEY`. |
| fireworks | Fireworks | https://api.fireworks.ai/inference | api_key | accounts/fireworks/models/deepseek-v4-flash | Env fallback `FIREWORKS_API_KEY`. |
| cerebras | Cerebras | https://api.cerebras.ai/v1 | api_key | gemma-4-31b | Env fallback `CEREBRAS_API_KEY`. |
| moonshotai | Moonshot AI | https://api.moonshot.ai/v1 | api_key | kimi-k2-0711-preview | Env fallback `MOONSHOT_API_KEY`. |
| moonshotai-cn | Moonshot AI CN | https://api.moonshot.cn/v1 | api_key | kimi-k2-0711-preview | China mirror; same env var. Env fallback `MOONSHOT_API_KEY`. |
| minimax | MiniMax | https://api.minimax.io/anthropic | api_key | MiniMax-M2.7 | Env fallback `MINIMAX_API_KEY`. |
| minimax-cn | MiniMax CN | https://api.minimaxi.com/anthropic | api_key | MiniMax-M2.7 | China mirror. Env fallback `MINIMAX_CN_API_KEY`. |
| kimi-coding | Kimi For Coding | https://api.kimi.com/coding | api_key | k2p7 | Env fallback `KIMI_API_KEY`. |
| zai | Z.AI | https://api.z.ai/api/coding/paas/v4 | api_key | glm-4.5-air | Zhipu GLM, international endpoint. Env fallback `ZAI_API_KEY`. |
| zai-coding-cn | Z.AI Coding CN | https://open.bigmodel.cn/api/coding/paas/v4 | api_key | glm-4.5-air | Zhipu GLM, China endpoint (bigmodel.cn = Zhipu/智谱). Env fallback `ZAI_CODING_CN_API_KEY`. This is the "GLM" preset. |
| ant-ling | Ant Ling | https://api.ant-ling.com/v1 | api_key | Ling-2.6-1T | Ant Group Ling models. Env fallback `ANT_LING_API_KEY`. |
| nvidia | NVIDIA | https://integrate.api.nvidia.com/v1 | api_key | meta/llama-3.1-70b-instruct | Env fallback `NVIDIA_API_KEY`. |
| huggingface | Hugging Face | https://router.huggingface.co/v1 | api_key | MiniMaxAI/MiniMax-M2 | Env fallback `HF_TOKEN`. |
| vercel-ai-gateway | Vercel AI Gateway | https://ai-gateway.vercel.sh | api_key | — | Env fallback `AI_GATEWAY_API_KEY`. |

### OAuth-only / cloud-credential providers (do NOT show as "paste key" presets)

| id | name | authType | notes |
|---|---|---|---|
| openai-codex | OpenAI Codex | oauth | ChatGPT Plus/Pro login flow only — no api_key path. Render as a "Login with ChatGPT" button, not a key field. |
| github-copilot | GitHub Copilot | api_key (+oauth) | Default preset fine (key works); also offers GitHub OAuth login. baseUrl https://api.individual.githubcopilot.com. Env fallback `COPILOT_GITHUB_TOKEN`. |
| google-vertex | Google Vertex | env (ADC/gcloud) | No static baseUrl; uses Google Cloud credentials. Advanced-only. |
| amazon-bedrock | Amazon Bedrock | env (AWS profile) | No static baseUrl; uses AWS credentials/bearer token. Advanced-only. |
| azure-openai-responses | Azure OpenAI | api_key (env) | No static baseUrl — user must supply their own Azure endpoint per-deployment. Not a clean preset. Env fallback `AZURE_OPENAI_API_KEY`. |
| cloudflare-ai-gateway | Cloudflare AI Gateway | api_key (special) | Cloudflare account-bound; advanced-only. |
| cloudflare-workers-ai | Cloudflare Workers AI | api_key (special) | Cloudflare account-bound; advanced-only. |
| opencode | OpenCode Zen | api_key | No static baseUrl (per-model). Skip as a preset. |
| opencode-go | OpenCode Zen Go | api_key | No static baseUrl (per-model). Skip as a preset. |
| xiaomi-token-plan-cn/ams/sgp | Xiaomi Token Plan (CN/AMS/SGP) | api_key | Regional Xiaomi token-plan endpoints; advanced-only. |

## Notes for settings-page design

1. **No "DashScope" provider exists in the SDK.** The closest "GLM" preset is `zai-coding-cn` (Zhipu/智谱, `open.bigmodel.cn`). Alibaba/Ant models are exposed via `ant-ling` (Ant Group's Ling/Ring models). If "DashScope" specifically is required, it is not a built-in pi provider — would need a custom `registerProvider` extension.
2. **`baseUrl` is fixed per preset** — the settings page should NOT expose a baseUrl field for these rows; only an API-key input (+ optional model picker). This is the whole point of "presets".
3. **Two auth UX modes are needed**: (a) key-paste presets (table above), (b) OAuth login buttons for `anthropic`, `xai`, `github-copilot`, `openai-codex`. `openai-codex` is oauth-only and must not show a key field.
4. **Env-var fallback**: every api_key provider lists an env var (e.g. `ANTHROPIC_API_KEY`). The settings page can label the key field "ANTHROPIC_API_KEY" to match convention and let users who set the env var see "configured via environment".
5. **China mirrors**: `moonshotai-cn`, `minimax-cn`, `zai-coding-cn` duplicate their intl siblings with `.cn`/`bigmodel.cn` endpoints — useful to show in a CN locale or behind a "region" toggle to avoid clutter.
