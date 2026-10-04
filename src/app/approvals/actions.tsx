"use client";
import { useState } from "react";

export function ApprovalActions({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const readError = async (r: Response): Promise<string> => {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `request failed (${r.status})`;
  };
  const act = async (decision: string, extra: object = {}) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...extra }),
      });
      if (!r.ok) setError(await readError(r));
      else location.reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/approvals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) setError(await readError(r));
      else {
        setEdit(false);
        location.reload();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {error && <div style={{ width: "100%", color: "#ff8080", fontSize: 13 }}>{error}</div>}
      <button disabled={busy} onClick={() => act("approved")} style={btn("#2f9e44")}>Approve & send</button>
      <button disabled={busy} onClick={() => act("rejected")} style={btn("#5b6572")}>Reject</button>
      <button disabled={busy} onClick={() => setEdit(!edit)} style={btn("#4f7cff")}>Edit</button>
      <button disabled={busy} onClick={() => act("regenerate")} style={btn("#9a6bff")}>Regenerate</button>
      <button disabled={busy} onClick={() => act("pause")} style={btn("#b7791f")}>Pause sequence</button>
      {edit && (
        <div style={{ width: "100%", marginTop: 8 }}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} style={{ width: "100%", background: "#0f141c", color: "#fff", border: "1px solid #2a3444", borderRadius: 8, padding: 8 }} placeholder="Edited message body…" />
          <button disabled={busy || !body} onClick={saveEdit} style={btn("#2f9e44")}>Save edit</button>
        </div>
      )}
    </div>
  );
}
const btn = (bg: string): React.CSSProperties => ({ padding: "8px 12px", borderRadius: 8, background: bg, color: "#fff", border: 0, cursor: "pointer" });
