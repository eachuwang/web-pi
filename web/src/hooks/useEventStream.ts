import { useEffect, useRef } from "react";
import { eventStreamUrl } from "../lib/api";

// Minimal mirror of AgentSessionEvent as parsed from the SSE stream. The exact
// union lives in the SDK; here we keep it loose (JSON over the wire) and narrow
// per-event in the consumer.
export type AgentEvent = { type: string; [key: string]: unknown };

// `sessionId` (G01) both picks the SSE target (eventStreamUrl(sessionId)) and
// drives reconnection: switching the active session reopens the EventSource for
// the new session's stream. On first load (sessionId undefined) the backend
// defaults to the first live session.
export function useEventStream(
  onEvent: (e: AgentEvent) => void,
  onState?: (connected: boolean) => void,
  sessionId?: string,
): void {
  // Keep the latest handlers without re-subscribing on every render.
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const sb = useRef(onState);
  sb.current = onState;
  useEffect(() => {
    const es = new EventSource(eventStreamUrl(sessionId));
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
  }, [sessionId]);
}
