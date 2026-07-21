import { useEffect, useRef } from "react";
import { eventStreamUrl } from "../lib/api";

// Minimal mirror of AgentSessionEvent as parsed from the SSE stream. The exact
// union lives in the SDK; here we keep it loose (JSON over the wire) and narrow
// per-event in the consumer.
export type AgentEvent = { type: string; [key: string]: unknown };

// Stall threshold (ms): if a turn is in progress (agent_start fired, no
// agent_end yet) and no real SSE event has arrived for this long, the upstream
// model has likely hung (or the connection silently died without an error
// event). The backend also probes on its keepalive tick and pushes a
// `session_stall` data event — handled here as the primary trigger; the local
// watchdog is a fallback for when no keepalive reaches us (flaky proxy).
const STALL_MS = 60_000;

// `sessionId` (G01) both picks the SSE target (eventStreamUrl(sessionId)) and
// drives reconnection: switching the active session reopens the EventSource for
// the new session's stream. `reconnectKey` lets the consumer force a reopen
// (used by the stall banner's "reconnect" action) without switching session.
// `onStall(stalled, ms)` fires on stall transitions: true when a turn goes
// silent past STALL_MS, false when an event arrives again (recovered).
export function useEventStream(
  onEvent: (e: AgentEvent) => void,
  onState?: (connected: boolean) => void,
  sessionId?: string,
  onStall?: (stalled: boolean, ms: number) => void,
  reconnectKey?: number,
): void {
  // Keep the latest handlers without re-subscribing on every render.
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const sb = useRef(onState);
  sb.current = onState;
  const stallCb = useRef(onStall);
  stallCb.current = onStall;
  const lastEventAt = useRef(0);
  const inTurn = useRef(false);
  const stalled = useRef(false);

  useEffect(() => {
    const es = new EventSource(eventStreamUrl(sessionId));
    es.onopen = () => {
      sb.current?.(true);
      if (stalled.current) {
        stalled.current = false;
        stallCb.current?.(false, 0);
      }
    };
    // EventSource auto-reconnects; onopen fires again on a successful reconnect.
    es.onerror = () => sb.current?.(false);
    es.onmessage = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as AgentEvent;
        // Backend stall probe: a `session_stall` frame means the server detected
        // the session is streaming but silent past STALL_MS. Don't reset
        // lastEventAt (the frame itself isn't model progress); only flip stalled.
        if (e.type === "session_stall") {
          if (!stalled.current) {
            stalled.current = true;
            stallCb.current?.(true, Number((e as { stalledMs?: number }).stalledMs ?? 0));
          }
          return;
        }
        lastEventAt.current = Date.now();
        if (e.type === "agent_start") inTurn.current = true;
        else if (e.type === "agent_end" || e.type === "agent_error") inTurn.current = false;
        if (stalled.current) {
          // an event arrived → recovered.
          stalled.current = false;
          stallCb.current?.(false, 0);
        }
        cb.current(e);
      } catch {
        // ignore malformed frames
      }
    };
    // Local watchdog: if in a turn and silent past STALL_MS, flag stall. Catches
    // the case where the backend keepalive/probe never reaches us (e.g. a proxy
    // that swallows comment frames, or the listener attached after the probe).
    const tick = setInterval(() => {
      if (inTurn.current && lastEventAt.current && Date.now() - lastEventAt.current > STALL_MS) {
        if (!stalled.current) {
          stalled.current = true;
          stallCb.current?.(true, Date.now() - lastEventAt.current);
        }
      }
    }, 5000);
    return () => {
      es.close();
      clearInterval(tick);
    };
  }, [sessionId, reconnectKey]);
}
