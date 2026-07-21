// web-pi self-contained config — owns its own provider config + credentials,
// does NOT depend on pi's ~/.pi/agent. (D01/G04 decisions.)
//
//   ~/.web-pi/config.json      providers list + maxSessions (non-secret)
//   ~/.web-pi/credentials.json providerId → apiKey (0600, plaintext, pi convention)
//
// On startup, applySettings() injects each provider into the SDK ModelRuntime:
// built-in preset → setRuntimeApiKey only; custom (non-builtin baseUrl) →
// registerProvider + setRuntimeApiKey.

import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const CONFIG_DIR = process.env.WEB_PI_HOME ?? join(homedir(), ".web-pi");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CREDS_PATH = join(CONFIG_DIR, "credentials.json");
const USAGE_PATH = join(CONFIG_DIR, "usage.json");

/** Per-model limit override for a custom provider. Keys are model ids.
 * When the provider is registered, each model's effective limits resolve as:
 *   modelConfig[id].contextWindow ?? provider.contextWindow ?? 128000
 *   modelConfig[id].maxTokens    ?? provider.maxTokens    ?? 8192
 *   modelConfig[id].reasoning    ?? provider.reasoning    ?? false
 * `source: "live"` marks a value auto-filled from GET {baseUrl}/models
 * (context_length / max_completion_tokens / reasoning) — the UI shows it
 * read-only. `source: "manual"` is a user-picked tier dropdown value. Absent
 * modelConfig entry → global default (ctx 128000 / max 8192 / reasoning false).
 * This keeps contextWindow (input) and maxTokens (output cap) per-model so
 * switching models inside one provider picks up the right limits — a 1M-context
 * model and a 200K model under the same custom provider no longer share one cap
 * (the bug: shared provider-level limits applied to every model). */
export type ModelLimits = {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  source?: "live" | "manual";
};

/** A provider the user has configured. `custom` entries need registerProvider. */
export type ProviderEntry = {
  id: string; // SDK providerId
  name?: string; // display name
  baseUrl?: string; // only for custom (non-builtin) providers
  api?: string; // wire format for custom providers (KnownApi, e.g. "openai-completions") — wires builtin streaming
  models?: string[]; // model ids this provider offers (custom: registered as the provider's catalog)
  contextWindow?: number; // DEFAULT input context window for models w/o an explicit per-model override
  maxTokens?: number; // DEFAULT max output tokens for models w/o an explicit per-model override
  reasoning?: boolean; // DEFAULT reasoning capability for models w/o an explicit per-model override
  modelConfig?: Record<string, ModelLimits>; // per-model ctx/maxTokens/reasoning (custom providers)
  custom?: boolean; // true → registerProvider(id, {baseUrl, api, models}) on apply
  enabled?: boolean; // default true; false = skip
};

/** Structural subset of ProviderEntry carrying the limit-related fields.
 * Lets callers (test endpoint) resolve limits from a request body without
 * fabricating a full ProviderEntry. */
export type ModelLimitSource = {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  modelConfig?: Record<string, ModelLimits>;
};

/** Resolve a model's effective limits: per-model override → provider default → global. */
export function resolveModelLimits(
  p: ModelLimitSource,
  modelId: string,
): { contextWindow: number; maxTokens: number; reasoning: boolean } {
  const mc = p.modelConfig?.[modelId];
  return {
    contextWindow: mc?.contextWindow ?? p.contextWindow ?? 128000,
    maxTokens: mc?.maxTokens ?? p.maxTokens ?? 8192,
    reasoning: mc?.reasoning ?? p.reasoning ?? false,
  };
}

export type Settings = {
  providers: ProviderEntry[];
  maxSessions: number;
};

const DEFAULTS: Settings = { providers: [], maxSessions: 4 };

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const providers: ProviderEntry[] = (parsed.providers ?? []).map((p: ProviderEntry & { model?: string }) => {
      // backward compat: old single `model: string` → `models: [model]`
      const models = Array.isArray(p.models)
        ? p.models
        : typeof p.model === "string" && p.model
          ? [p.model]
          : [];
      const { model: _drop, ...rest } = p;
      return { ...rest, models };
    });
    return {
      providers,
      maxSessions: typeof parsed.maxSessions === "number" ? parsed.maxSessions : DEFAULTS.maxSessions,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export async function loadCredentials(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(CREDS_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function saveCredentials(c: Record<string, string>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDS_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(CREDS_PATH, 0o600); // ensure 0600 even if file pre-existed
}

// G02 cost odometer — cross-session spend persisted to ~/.web-pi/usage.json.
// getSessionStats() already recomputes per-session cost cumulatively from the
// session file (survives resume/restart for one session); the odometer's job is
// the cross-session aggregate (total spend across every session ever) which
// per-session stats can't give. Keyed by sessionFile (stable identity across
// resume; sessionId may rotate on resume). Each entry is a snapshot, overwritten
// on each flush — never additive — so resume/restart can't double-count.
export type UsageTokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type UsageEntry = {
  sessionFile: string;
  cwd?: string;
  cost: number;
  tokens: UsageTokens;
  toolCalls: number;
  totalMessages: number;
  updated: number; // epoch ms
};
export type UsageTotals = { cost: number; tokens: UsageTokens; toolCalls: number };
export type UsageData = {
  sessions: Record<string, UsageEntry>; // keyed by sessionFile
  total: UsageTotals;
  updated: number;
};

const EMPTY_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export async function loadUsage(): Promise<UsageData> {
  try {
    const raw = JSON.parse(await readFile(USAGE_PATH, "utf8")) as Partial<UsageData>;
    return {
      sessions: typeof raw.sessions === "object" && raw.sessions ? raw.sessions : {},
      total: raw.total ?? { cost: 0, tokens: { ...EMPTY_TOKENS }, toolCalls: 0 },
      updated: raw.updated ?? 0,
    };
  } catch {
    return { sessions: {}, total: { cost: 0, tokens: { ...EMPTY_TOKENS }, toolCalls: 0 }, updated: 0 };
  }
}

function recomputeTotal(sessions: Record<string, UsageEntry>): UsageTotals {
  const tot: UsageTotals = { cost: 0, tokens: { ...EMPTY_TOKENS }, toolCalls: 0 };
  for (const e of Object.values(sessions)) {
    tot.cost += e.cost;
    tot.toolCalls += e.toolCalls;
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      tot.tokens[k] += e.tokens[k];
    }
  }
  return tot;
}

// Upsert one session's snapshot, recompute cross-session totals, persist.
// Accepts a minimal struct (not the SDK SessionStats type) so config.ts stays
// decoupled from SDK internals. No-op if sessionFile is undefined (can't key).
let usageWriteLock: Promise<void> = Promise.resolve();
export async function recordUsage(
  s: { sessionFile?: string; cost: number; tokens: UsageTokens; toolCalls: number; totalMessages: number },
  cwd?: string,
): Promise<void> {
  if (!s.sessionFile) return;
  // Serialize writes so concurrent flushes (multi-session interval + agent_end)
  // don't clobber each other's read-modify-write.
  usageWriteLock = usageWriteLock.then(async () => {
    const data = await loadUsage();
    data.sessions[s.sessionFile!] = {
      sessionFile: s.sessionFile!,
      cwd,
      cost: s.cost,
      tokens: s.tokens,
      toolCalls: s.toolCalls,
      totalMessages: s.totalMessages,
      updated: Date.now(),
    };
    data.total = recomputeTotal(data.sessions);
    data.updated = Date.now();
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(USAGE_PATH, JSON.stringify(data, null, 2));
  });
  await usageWriteLock;
}

/**
 * Inject configured providers + keys into the SDK ModelRuntime instance.
 * Idempotent: registerProvider overwrites, setRuntimeApiKey overwrites.
 * Custom providers previously registered but no longer in `settings` are
 * unregistered (so deleting a custom provider removes it from the picker).
 * Errors per-provider are logged, not thrown, so one bad entry doesn't break startup.
 *
 * Custom (non-builtin) providers: registered with `api` (wire format, wires the
 * SDK's builtin streaming impl — no streamSimple needed) + a models spec so the
 * model appears in getAvailable. This mirrors how pi's models.json defines a
 * custom OpenAI-compatible provider.
 */
const registeredCustom = new Set<string>();

export async function applySettings(
  mr: ModelRuntime,
  settings: Settings,
  creds: Record<string, string>,
): Promise<{ applied: string[]; failed: { id: string; error: string }[] }> {
  const applied: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const nextCustom = new Set<string>();
  for (const p of settings.providers) {
    if (p.enabled === false) continue;
    if (p.custom && p.baseUrl) nextCustom.add(p.id);
  }
  // Unregister custom providers that were registered before but are gone now.
  for (const id of registeredCustom) {
    if (!nextCustom.has(id)) {
      try {
        mr.unregisterProvider(id);
      } catch {
        // already gone / nevermind
      }
      registeredCustom.delete(id);
    }
  }
  for (const p of settings.providers) {
    if (p.enabled === false) continue;
    try {
      if (p.custom && p.baseUrl) {
        const api = p.api || "openai-completions";
        const modelIds = p.models && p.models.length ? p.models : [p.id];
        // Per-model limits: resolve each model's ctx/maxTokens via its own
        // override → provider default → global. Registering each model with its
        // own limits means setModel(model) picks up the right caps per model —
        // a 1M ctx model vs a 200K model under one provider no longer share one
        // value. maxTokens is MAX OUTPUT (max_completion_tokens), NOT the input
        // context window — decoupled so a 1M input window doesn't blow past an
        // endpoint's output cap (e.g. GLM caps at 131072).
        const limits = modelIds.map((id) => ({ id, ...resolveModelLimits(p, id) }));
        mr.registerProvider(p.id, {
          name: p.name ?? p.id,
          baseUrl: p.baseUrl,
          authHeader: true,
          api,
          models: limits.map(({ id, contextWindow, maxTokens, reasoning }) => ({
            id,
            name: id,
            api,
            reasoning,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow,
            maxTokens,
          })),
        });
        registeredCustom.add(p.id);
      }
      const key = creds[p.id];
      if (key) await mr.setRuntimeApiKey(p.id, key);
      applied.push(p.id);
    } catch (e) {
      failed.push({ id: p.id, error: String(e) });
    }
  }
  return { applied, failed };
}

export { CONFIG_DIR };
