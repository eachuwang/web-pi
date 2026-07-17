import { useEffect, useRef } from "react";
import { eventStreamUrl } from "../lib/api";

// Minimal mirror of AgentSessionEvent as parsed from the SSE stream. The exact
// union lives in the SDK; here we keep it loose (JSON over the wire) and narrow
// per-event in the consumer.
export type AgentEvent = { type: string; [key: string]: unknown };

// `nonce` lets the caller force a reconnect (e.g. after a session switch): a
// change tears down the old EventSource and opens a fresh one, whose first
// frame is a session_init for the new session.
export function useEventStream(
  onEvent: (e: AgentEvent) => void,
  onState?: (connected: boolean) => void,
  nonce?: number,
): void {
  // Keep the latest handlers without re-subscribing on every render.
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const sb = useRef(onState);
  sb.current = onState;
  useEffect(() => {
    const es = new EventSource(eventStreamUrl());
    es.onopen = () => sb.current?.(true);
    // EventSource auto-reconnects; onopen fires again on a successful reconnect.
    es.onerror = () => sb.current?.(false);
    es.onmessage = (ev: MessageEvent) => {
      try {
        cb.current(JSON.parse(ev.data) as AgentEvent);
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [nonce]);
}
