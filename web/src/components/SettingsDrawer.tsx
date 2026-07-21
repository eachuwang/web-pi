import { useEffect, useState } from "react";
import {
  getSettings,
  putSettings,
  reloadSettings,
  testProvider,
  type SettingsProvider,
  type TestModel,
} from "../lib/api";
import { PRESET_PROVIDERS, PRESET_BY_ID } from "../lib/presets";

// Right-side NON-MODAL drawer (G03-Q6): coexists with chat — no blocking
// backdrop, chat stays interactive. Configures model providers (D01/G03):
// presets (fixed baseUrl, key only) + custom (id/baseUrl/api/key/model), per-
// provider model fetched via "test" (= test connection), max-sessions, reload.
//
// ctx / maxTokens / reasoning are NOT user-typed numbers anymore (B2): for
// custom providers, "fetch models" calls GET {baseUrl}/models and auto-fills
// context_length / max_completion_tokens / reasoning when the endpoint returns
// them (OpenRouter, Together, vLLM, …) — those show READ-ONLY. Endpoints that
// don't surface them (plain OpenAI /models) → a TIER DROPDOWN (128K/200K/1M…)
// so the user picks a bucket instead of typing a raw token count. Preset
// providers use the SDK's built-in per-model catalog (read-only, no inputs).
//
// Custom providers register with `api` (wire format) — the SDK wires builtin
// streaming from the api string, so a custom OpenAI-compatible endpoint with
// api="openai-completions" actually streams. (streamSimple not needed.)

const API_OPTIONS = [
  { id: "openai-completions", name: "openai-completions (OpenAI chat / most mirrors)" },
  { id: "openai-responses", name: "openai-responses" },
  { id: "anthropic-messages", name: "anthropic-messages" },
  { id: "google-generative-ai", name: "google-generative-ai" },
  { id: "mistral-conversations", name: "mistral-conversations" },
  { id: "pi-messages", name: "pi-messages" },
];

// Context-window tiers (input tokens) and max-output tiers (max_completion_tokens).
// Replaces raw token number inputs — the user picks a bucket; B2 auto-fill from
// GET /models shows the live value read-only instead.
const CTX_TIERS = [128000, 200000, 256000, 512000, 1000000, 1048576];
const MAX_TIERS = [8192, 16384, 32768, 65536, 131072];

function formatSize(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n === 1048576) return "1M";
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

// A <select> of tier buckets. If the current value isn't an exact tier (e.g. a
// B2 live value like 1048756, or a stale manual value), it's prepended as a
// custom option so the user sees what's set and can still switch to a tier.
function TierSelect({
  value,
  tiers,
  onChange,
  blankLabel = "default",
}: {
  value: number | undefined;
  tiers: number[];
  onChange: (n: number) => void;
  blankLabel?: string;
}) {
  const hasTier = value != null && tiers.includes(value);
  return (
    <select
      className="sd-input sd-tier"
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? 0 : Number(v));
      }}
    >
      <option value="">{blankLabel}</option>
      {!hasTier && value != null && value > 0 && (
        <option value={value}>{formatSize(value)} (custom)</option>
      )}
      {tiers.map((t) => (
        <option key={t} value={t}>
          {formatSize(t)}
        </option>
      ))}
    </select>
  );
}

type Row = SettingsProvider & { modelOptions?: TestModel[]; testing?: boolean; testErr?: string; expanded?: boolean };

export function SettingsDrawer({
  onClose,
  onProvidersChanged,
}: {
  onClose: () => void;
  onProvidersChanged?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [maxSessions, setMaxSessions] = useState(4);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; msg: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setRows(
        s.providers.map((p) => ({
          ...p,
          apiKey: "",
          // custom rows load collapsed (compact card); edit expands.
          expanded: p.custom ? false : undefined,
        })),
      );
      setMaxSessions(s.maxSessions ?? 4);
    })().catch((e) => setStatus({ kind: "err", msg: `load failed: ${String(e)}` }));
  }, []);

  function patch(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  }

  // Write a per-model field into modelConfig. ctx/maxTokens take a number
  // (0 = clear → falls back to provider/global default); reasoning takes a
  // boolean. Keyed by model id — empty ids hold no override until typed.
  function setModelField(id: string, modelId: string, field: "contextWindow" | "maxTokens" | "reasoning", value: number | boolean) {
    if (!modelId) return;
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const mc = { ...(r.modelConfig ?? {}) };
        const cur = mc[modelId] ?? {};
        const next = { ...cur };
        if (field === "reasoning") {
          next.reasoning = value as boolean;
        } else {
          const n = value as number;
          if (n > 0) next[field] = n;
          else delete next[field];
        }
        if (next.contextWindow || next.maxTokens || next.reasoning !== undefined) mc[modelId] = next;
        else delete mc[modelId];
        return { ...r, modelConfig: mc };
      }),
    );
    setDirty(true);
  }

  function addPreset(presetId: string) {
    if (rows.some((r) => r.id === presetId)) return;
    const p = PRESET_BY_ID.get(presetId);
    setRows((rs) => [
      ...rs,
      {
        id: presetId,
        name: p?.name,
        models: p?.exampleModelId ? [p.exampleModelId] : [],
        custom: false,
        enabled: true,
        apiKey: "",
      },
    ]);
    setDirty(true);
  }

  function addCustom() {
    const id = `custom-${rows.length + 1}`;
    setRows((rs) => [
      ...rs,
      { id, custom: true, enabled: true, apiKey: "", baseUrl: "", models: [], api: "openai-completions", expanded: true },
    ]);
    setDirty(true);
  }

  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setDirty(true);
  }

  async function fetchModels(r: Row) {
    patch(r.id, { testing: true, testErr: undefined });
    const res = await testProvider({
      providerId: r.id,
      apiKey: r.apiKey || undefined,
      baseUrl: r.custom ? r.baseUrl : undefined,
      api: r.custom ? r.api : undefined,
      models: r.custom ? r.models : undefined,
      contextWindow: r.custom ? r.contextWindow : undefined,
      maxTokens: r.custom ? r.maxTokens : undefined,
      reasoning: r.custom ? r.reasoning : undefined,
      modelConfig: r.custom ? r.modelConfig : undefined,
      custom: r.custom,
    });
    if (res.ok && res.models) {
      // B2: auto-fill per-model ctx/maxTokens/reasoning from the live /models
      // response. Live values are written into modelConfig (source:"live") so
      // they persist + register correctly, and the UI shows them read-only via
      // modelOptions' per-field live flags. Non-live fields stay unset → the
      // tier dropdown handles them.
      const mc = { ...(r.modelConfig ?? {}) };
      for (const m of res.models) {
        const cur = mc[m.id] ?? {};
        const next = { ...cur, source: "live" as const };
        if (m.contextWindowLive && m.contextWindow) next.contextWindow = m.contextWindow;
        if (m.maxTokensLive && m.maxTokens) next.maxTokens = m.maxTokens;
        if (m.reasoningLive) next.reasoning = m.reasoning;
        mc[m.id] = next;
      }
      patch(r.id, {
        models: res.models.map((m) => m.id),
        modelOptions: res.models,
        modelConfig: mc,
        testing: false,
      });
      if (res.source === "live") {
        const filled = res.models.filter((m) => m.contextWindowLive || m.maxTokensLive).length;
        setStatus({ kind: "ok", msg: `${r.id}: ${res.models.length} models fetched — key OK${filled ? ` · ${filled} auto-filled` : ""}` });
      } else if (res.warning) {
        setStatus({ kind: "err", msg: `${r.id}: ${res.warning}` });
      } else {
        setStatus({ kind: "info", msg: `${r.id}: ${res.models.length} model(s) (registered; key not validated against endpoint)` });
      }
      onProvidersChanged?.();
    } else {
      patch(r.id, { testing: false, testErr: res.error ?? "fetch failed" });
      setStatus({ kind: "err", msg: `${r.id}: ${res.error ?? "fetch failed"}` });
    }
  }

  async function save() {
    setSaving(true);
    for (const r of rows) {
      if (r.custom && (!r.id || !r.baseUrl)) {
        setStatus({ kind: "err", msg: `custom provider needs id + baseUrl` });
        setSaving(false);
        return;
      }
    }
    const res = await putSettings({ providers: rows, maxSessions });
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      setRows((rs) => rs.map((r) => (r.custom ? { ...r, expanded: false } : r)));
      const fail = res.failed?.length ?? 0;
      setStatus({
        kind: fail ? "err" : "ok",
        msg: fail ? `saved; ${fail} provider(s) failed to apply` : `saved — ${res.applied?.length ?? 0} provider(s) applied`,
      });
      onProvidersChanged?.();
    } else {
      setStatus({ kind: "err", msg: "save failed" });
    }
  }

  async function reload() {
    const res = await reloadSettings();
    setStatus({
      kind: res.failed?.length ? "err" : "ok",
      msg: `reloaded — ${res.applied?.length ?? 0} applied${res.failed?.length ? `, ${res.failed.length} failed` : ""}`,
    });
    onProvidersChanged?.();
  }

  return (
    <aside className="settings-drawer" role="dialog" aria-label="Settings">
      <header className="sd-head">
        <h2>Settings</h2>
        <button className="sd-close" onClick={onClose} title="close">✕</button>
      </header>
      <div className="sd-body">
      <section className="sd-section">
        <div className="sd-section-title">
          <span>Model Providers</span>
          <button className="sd-add" onClick={addCustom} title="add custom provider">+ custom</button>
        </div>

        <div className="sd-add-preset">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) addPreset(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="">+ add preset provider…</option>
            {PRESET_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {rows.length === 0 && <div className="sd-empty">no providers configured — add a preset above.</div>}

        <div className="sd-providers">
          {rows.map((r) => (
            <ProviderRow
              key={r.id}
              row={r}
              onChange={(p) => patch(r.id, p)}
              onModelField={(mid, field, v) => setModelField(r.id, mid, field, v)}
              onRemove={() => removeRow(r.id)}
              onFetch={() => void fetchModels(r)}
              onToggleExpand={() => patch(r.id, { expanded: !r.expanded })}
            />
          ))}
        </div>
      </section>

      <section className="sd-section">
        <div className="sd-section-title">Max concurrent sessions</div>
        <input
          className="sd-input sd-num"
          type="number"
          min={1}
          max={16}
          value={maxSessions}
          onChange={(e) => {
            setMaxSessions(Number(e.target.value) || 4);
            setDirty(true);
          }}
        />
        <div className="sd-hint">applies to the multi-session build (G01); v1 single-session ignores this.</div>
      </section>

      {status && <div className={`sd-status sd-${status.kind}`}>{status.msg}</div>}
      </div>

      <footer className="sd-foot">
        <button className="sd-btn-ghost" onClick={() => void reload()}>Reload providers</button>
        <button className="sd-btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </aside>
  );
}

function ProviderRow({
  row,
  onChange,
  onModelField,
  onRemove,
  onFetch,
  onToggleExpand,
}: {
  row: Row;
  onChange: (p: Partial<Row>) => void;
  onModelField: (modelId: string, field: "contextWindow" | "maxTokens" | "reasoning", value: number | boolean) => void;
  onRemove: () => void;
  onFetch: () => void;
  onToggleExpand: () => void;
}) {
  const preset = !row.custom ? PRESET_BY_ID.get(row.id) : undefined;
  const keyLabel = preset?.envVar ?? "API KEY";
  const collapsed = row.custom && !row.expanded;
  return (
    <div className={`sd-row${row.custom ? " sd-row-custom" : ""}${collapsed ? " sd-row-collapsed" : ""}`}>
      <div className="sd-row-head">
        <span className="sd-row-name">{preset?.name ?? row.name ?? row.id}</span>
        {row.custom && <span className="sd-tag">custom</span>}
        {!row.custom && <span className="sd-tag sd-tag-preset">preset</span>}
        {row.hasKey && !row.apiKey && <span className="sd-tag sd-tag-key" title="key saved">key ✓</span>}
        {row.custom && (
          <button className="sd-row-edit" onClick={onToggleExpand} title={collapsed ? "edit" : "collapse"}>
            {collapsed ? "✎ edit" : "▴ collapse"}
          </button>
        )}
        <button className="sd-row-del" onClick={onRemove} title="remove">✕</button>
      </div>

      {collapsed && (
        <div className="sd-row-summary">
          {row.baseUrl && <span className="sd-summary-bit" title={row.baseUrl}>{row.baseUrl.replace(/^https?:\/\//, "")}</span>}
          <span className="sd-summary-bit">{(row.models ?? []).length || 0} model(s)</span>
        </div>
      )}

      {row.custom && !collapsed && (
        <>
          <label className="sd-field">
            <span>provider id</span>
            <input
              className="sd-input"
              value={row.id}
              placeholder="my-provider"
              onChange={(e) => onChange({ id: e.target.value })}
            />
          </label>
          <label className="sd-field">
            <span>base url</span>
            <input
              className="sd-input"
              value={row.baseUrl ?? ""}
              placeholder="https://…"
              onChange={(e) => onChange({ baseUrl: e.target.value })}
            />
          </label>
          <label className="sd-field">
            <span>api (wire format)</span>
            <select
              className="sd-input"
              value={row.api ?? "openai-completions"}
              onChange={(e) => onChange({ api: e.target.value })}
            >
              {API_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {(!row.custom || !collapsed) && (
        <>
          <label className="sd-field">
            <span>{keyLabel.toLowerCase()}</span>
            <input
              className="sd-input"
              type="password"
              value={row.apiKey ?? ""}
              placeholder={row.hasKey ? "•••• (enter to replace)" : "paste api key"}
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
          </label>

          <div className="sd-models">
            <div className="sd-models-head">
              <span>models</span>
              <button
                className="sd-add-model"
                type="button"
                onClick={() => onChange({ models: [...(row.models ?? []), ""] })}
                title="add another model id"
              >
                + model
              </button>
            </div>
            {(row.models ?? []).length === 0 && (
              <div className="sd-hint">
                no model ids — click “+ model” to add one, or “fetch models” to enumerate + auto-fill ctx/tokens from the endpoint.
              </div>
            )}
            {(row.models ?? []).map((mid, i) => {
              const opt = row.modelOptions?.find((m) => m.id === mid);
              const cfg = row.modelConfig?.[mid];
              const ctxLive = opt?.contextWindowLive === true;
              const maxLive = opt?.maxTokensLive === true;
              const ctxVal = cfg?.contextWindow ?? opt?.contextWindow;
              const maxVal = cfg?.maxTokens ?? opt?.maxTokens;
              const reasoningVal = cfg?.reasoning ?? opt?.reasoning ?? false;
              return (
                <div className="sd-model-item" key={i}>
                  <div className="sd-model-id-row">
                    <input
                      className="sd-input"
                      list={`models-${row.id}`}
                      value={mid}
                      placeholder={preset?.exampleModelId || "model id"}
                      onChange={(e) => {
                        const next = [...(row.models ?? [])];
                        const oldMid = next[i];
                        const newMid = e.target.value;
                        next[i] = newMid;
                        // Re-key per-model limits so renaming a model keeps its
                        // ctx/maxTokens/reasoning override (only when both ids
                        // are non-empty; clearing the id leaves the override
                        // under the old key, harmless and re-attached if restored).
                        let mc = row.modelConfig;
                        if (mc && oldMid && newMid && mc[oldMid]) {
                          const { [oldMid]: v, ...rest } = mc;
                          mc = { ...rest, [newMid]: v };
                        }
                        let opts = row.modelOptions;
                        if (opts && oldMid && newMid) {
                          opts = opts.map((m) => (m.id === oldMid ? { ...m, id: newMid } : m));
                        }
                        onChange({ models: next, ...(mc !== row.modelConfig ? { modelConfig: mc } : {}), ...(opts !== row.modelOptions ? { modelOptions: opts } : {}) });
                      }}
                    />
                    <button
                      className="sd-model-del"
                      type="button"
                      title="remove model"
                      onClick={() => onChange({ models: (row.models ?? []).filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                  {row.custom && mid && (
                    <div className="sd-model-limits">
                      <label className="sd-mini-field" title={ctxLive ? "auto-filled from /models (read-only)" : "context window tier"}>
                        <span>ctx</span>
                        {ctxLive && ctxVal ? (
                          <span className="sd-readonly">{formatSize(ctxVal)} <em>auto</em></span>
                        ) : (
                          <TierSelect value={ctxVal} tiers={CTX_TIERS} onChange={(n) => onModelField(mid, "contextWindow", n)} />
                        )}
                      </label>
                      <label className="sd-mini-field" title={maxLive ? "auto-filled from /models (read-only)" : "max output tier"}>
                        <span>max out</span>
                        {maxLive && maxVal ? (
                          <span className="sd-readonly">{formatSize(maxVal)} <em>auto</em></span>
                        ) : (
                          <TierSelect value={maxVal} tiers={MAX_TIERS} onChange={(n) => onModelField(mid, "maxTokens", n)} />
                        )}
                      </label>
                      <label className="sd-mini-field sd-reasoning" title="model supports reasoning/thinking">
                        <input
                          type="checkbox"
                          checked={reasoningVal}
                          onChange={(e) => onModelField(mid, "reasoning", e.target.checked)}
                        />
                        <span>reasoning</span>
                      </label>
                    </div>
                  )}
                  {!row.custom && mid && opt && (ctxVal || maxVal) && (
                    // Preset providers: SDK catalog supplies ctx/maxTokens — read-only hint.
                    <div className="sd-model-limits sd-preset-limits">
                      {ctxVal ? <span className="sd-readonly">{formatSize(ctxVal)} ctx</span> : null}
                      {maxVal ? <span className="sd-readonly">{formatSize(maxVal)} out</span> : null}
                      {opt.reasoning ? <span className="sd-readonly">reasoning ✓</span> : null}
                    </div>
                  )}
                </div>
              );
            })}
            <datalist id={`models-${row.id}`}>
              {(row.modelOptions ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </datalist>
            <button className="sd-fetch" onClick={onFetch} disabled={row.testing} title="fetch models + test key + auto-fill ctx/tokens">
              {row.testing ? "…" : "fetch models"}
            </button>
          </div>
          {row.testErr && <div className="sd-err">{row.testErr}</div>}
        </>
      )}
    </div>
  );
}
