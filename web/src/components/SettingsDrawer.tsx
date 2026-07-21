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
import { TokenSizeInput } from "./TokenSizeInput";

// Right-side NON-MODAL drawer (G03-Q6): coexists with chat — no blocking
// backdrop, chat stays interactive. Configures model providers (D01/G03):
// presets (fixed baseUrl, key only) + custom (id/baseUrl/api/key/model), per-
// provider model fetched via "test" (= test connection), max-sessions, reload.
//
// Custom providers register with `api` (wire format) — the SDK wires builtin
// streaming from the api string (getApiProvider), so a custom OpenAI-compatible
// endpoint with api="openai-completions" actually streams. This mirrors pi's
// models.json. (R02/R03-era finding: api field is the key; streamSimple not needed.)

const API_OPTIONS = [
  { id: "openai-completions", name: "openai-completions (OpenAI chat / most mirrors)" },
  { id: "openai-responses", name: "openai-responses" },
  { id: "anthropic-messages", name: "anthropic-messages" },
  { id: "google-generative-ai", name: "google-generative-ai" },
  { id: "mistral-conversations", name: "mistral-conversations" },
  { id: "pi-messages", name: "pi-messages" },
];

// Parse a context-window size with k / M shorthand: "1M" → 1_000_000,
// "128k" → 128_000, "200000" → 200_000. Returns undefined if unparseable.
function formatSize(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

type Row = SettingsProvider & { modelOptions?: TestModel[]; testing?: boolean; testErr?: string; expanded?: boolean };

export function SettingsDrawer({
  onClose,
  onProvidersChanged,
}: {
  onClose: () => void;
  onProvidersChanged?: () => void;
}) {  const [rows, setRows] = useState<Row[]>([]);
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
          // #6: custom rows load collapsed (compact card); edit expands.
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

  // Per-model ctx/maxTokens override: n=0 clears the field so it falls back to
  // the provider default. Keyed by model id — empty ids (a fresh blank row) hold
  // no override until the user types an id.
  function setModelLimit(id: string, modelId: string, field: "contextWindow" | "maxTokens", n: number) {
    if (!modelId) return;
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const mc = { ...(r.modelConfig ?? {}) };
        const cur = mc[modelId] ?? {};
        const next = { ...cur };
        if (n > 0) next[field] = n;
        else delete next[field];
        if (next.contextWindow || next.maxTokens) mc[modelId] = next;
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
    // give it a temp unique id until the user fills it
    const id = `custom-${rows.length + 1}`;
    setRows((rs) => [
      ...rs,
      // #7: default max output tokens 128K (131072).
      { id, custom: true, enabled: true, apiKey: "", baseUrl: "", models: [], api: "openai-completions", contextWindow: 128000, maxTokens: 131072, expanded: true },
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
      modelConfig: r.custom ? r.modelConfig : undefined,
      custom: r.custom,
    });
    if (res.ok && res.models) {
      patch(r.id, { modelOptions: res.models, testing: false });
      if (res.source === "live") {
        setStatus({ kind: "ok", msg: `${r.id}: ${res.models.length} models fetched — key OK` });
      } else if (res.warning) {
        setStatus({ kind: "err", msg: `${r.id}: ${res.warning}` });
      } else {
        setStatus({ kind: "info", msg: `${r.id}: ${res.models.length} model(s) (registered; key not validated against endpoint)` });
      }
      // /test registered the provider + set the key on the shared ModelRuntime,
      // so the new model is now available to the top-bar picker — refresh it.
      onProvidersChanged?.();
    } else {
      patch(r.id, { testing: false, testErr: res.error ?? "fetch failed" });
      setStatus({ kind: "err", msg: `${r.id}: ${res.error ?? "fetch failed"}` });
    }
  }

  async function save() {
    setSaving(true);
    // validate custom rows have id+baseUrl
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
      // #6: collapse custom rows after save so the drawer doesn't hog space.
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
              onModelLimit={(mid, field, n) => setModelLimit(r.id, mid, field, n)}
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
  onModelLimit,
  onRemove,
  onFetch,
  onToggleExpand,
}: {
  row: Row;
  onChange: (p: Partial<Row>) => void;
  onModelLimit: (modelId: string, field: "contextWindow" | "maxTokens", n: number) => void;
  onRemove: () => void;
  onFetch: () => void;
  onToggleExpand: () => void;
}) {
  const preset = !row.custom ? PRESET_BY_ID.get(row.id) : undefined;
  const keyLabel = preset?.envVar ?? "API KEY";
  // #6: custom rows collapse to a compact card; edit expands.
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
          <span className="sd-summary-bit">{formatSize(row.contextWindow ?? 128000)} ctx</span>
          <span className="sd-summary-bit">{formatSize(row.maxTokens ?? 131072)} out</span>
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
          <label className="sd-field">
            <span>default context window (input tokens) — for models without an explicit override</span>
            <TokenSizeInput value={row.contextWindow} onChange={(n) => onChange({ contextWindow: n })} placeholder="e.g. 128k" />
          </label>
          <label className="sd-field">
            <span>default max output tokens — for models without an explicit override</span>
            <TokenSizeInput value={row.maxTokens} onChange={(n) => onChange({ maxTokens: n })} placeholder="e.g. 128k" />
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
              <div className="sd-hint">no model ids — click “+ model” to add one (or “fetch models” to enumerate).</div>
            )}
            {(row.models ?? []).map((mid, i) => (
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
                      // ctx/maxTokens override (only when both ids are non-empty;
                      // clearing the id leaves the override under the old key,
                      // harmless and re-attached if the id is restored).
                      let mc = row.modelConfig;
                      if (mc && oldMid && newMid && mc[oldMid]) {
                        const { [oldMid]: v, ...rest } = mc;
                        mc = { ...rest, [newMid]: v };
                      }
                      onChange({ models: next, ...(mc !== row.modelConfig ? { modelConfig: mc } : {}) });
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
                    <label className="sd-mini-field">
                      <span>ctx</span>
                      <TokenSizeInput value={row.modelConfig?.[mid]?.contextWindow} onChange={(n) => onModelLimit(mid, "contextWindow", n)} placeholder="default" />
                    </label>
                    <label className="sd-mini-field">
                      <span>max out</span>
                      <TokenSizeInput value={row.modelConfig?.[mid]?.maxTokens} onChange={(n) => onModelLimit(mid, "maxTokens", n)} placeholder="default" />
                    </label>
                  </div>
                )}
              </div>
            ))}
            <datalist id={`models-${row.id}`}>
              {(row.modelOptions ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </datalist>
            <button className="sd-fetch" onClick={onFetch} disabled={row.testing} title="fetch models + test key">
              {row.testing ? "…" : "fetch models"}
            </button>
          </div>
          {row.testErr && <div className="sd-err">{row.testErr}</div>}
        </>
      )}
    </div>
  );
}
