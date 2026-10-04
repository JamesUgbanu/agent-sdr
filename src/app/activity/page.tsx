"use client";
import { useEffect, useState } from "react";
export default function Activity() {
  const [events, setEvents] = useState<string[]>([]);
  useEffect(() => {
    const es = new EventSource("/api/activity/stream");
    es.onmessage = (e) => setEvents((p) => [e.data, ...p].slice(0, 100));
    return () => es.close();
  }, []);
  return (
    <div>
      <h1>Agent Activity</h1>
      <p style={{ color: "#9fb0c3" }}>Live SSE stream of agent runs, tool calls, approvals, sends.</p>
      <ul>{events.map((e, i) => <li key={i} style={{ fontFamily: "monospace", fontSize: 13 }}>{e}</li>)}</ul>
    </div>
  );
}
