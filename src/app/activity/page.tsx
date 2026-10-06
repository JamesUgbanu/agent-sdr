"use client";
import { useEffect, useRef, useState } from "react";

interface AgentEvent {
  kind?: string;
  message?: string;
  at?: string;
}

function parseEvent(data: string): AgentEvent | null {
  try {
    const j = JSON.parse(data) as unknown;
    if (Array.isArray(j)) return null; // batch payload — expanded below
    if (typeof j === "object" && j !== null) {
      if ((j as { type?: string }).type === "connected") return null; // handshake, not an event
      return j as AgentEvent;
    }
    return { message: data };
  } catch {
    return data.startsWith("{") ? null : { message: data };
  }
}

export default function Activity() {
  const [events, setEvents] = useState<Array<AgentEvent & { key: number }>>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const keyRef = useRef(0);
  useEffect(() => {
    const es = new EventSource("/api/activity/stream");
    es.onopen = () => setStatus("live");
    es.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data) as unknown;
        const list = (Array.isArray(j) ? j : [j]) as AgentEvent[];
        const parsed = list
          .map((ev) => ({ ...ev, key: keyRef.current++ }))
          .filter((ev) => (ev as { type?: string }).type !== "connected");
        if (parsed.length) setEvents((p) => [...parsed, ...p].slice(0, 100));
      } catch {
        const single = parseEvent(e.data);
        if (single) setEvents((p) => [{ ...single, key: keyRef.current++ }, ...p].slice(0, 100));
      }
    };
    es.onerror = () => setStatus("error");
    return () => es.close();
  }, []);
  return (
    <div>
      <h1>Agent Activity</h1>
      <p style={{ color: "#9fb0c3" }}>
        Live agent runs, tool calls, approvals, sends.{" "}
        {status === "live" ? (
          <span style={{ color: "#2f9e44" }}>● Live</span>
        ) : status === "error" ? (
          <span style={{ color: "#ff8080" }}>● Disconnected — retrying automatically. Events below may be stale.</span>
        ) : (
          <span style={{ color: "#9fb0c3" }}>● Connecting…</span>
        )}
      </p>
      {events.length === 0 && status === "live" && (
        <p style={{ color: "#9fb0c3" }}>No agent activity yet. Create a campaign to start the agent — runs appear here in real time.</p>
      )}
      <ul style={{ paddingLeft: 18 }}>
        {events.map((e) => (
          <li key={e.key} style={{ fontFamily: "monospace", fontSize: 13, marginBottom: 4 }}>
            {e.at && <span style={{ color: "#9fb0c3" }}>{new Date(e.at).toLocaleTimeString()} </span>}
            {e.kind && <span style={{ color: "#7ea4ff" }}>[{e.kind}] </span>}
            <span>{e.message ?? "(unparseable event)"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
