"use client";
import { useEffect, useState } from "react";
import { Badge, EmptyState, ErrorBox } from "../ui";

interface Check { provider: string; kind: string; status: string; message: string; }

export function IntegrationStatus({ workspaceId }: { workspaceId: string }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);

  async function load() {
    setChecking(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/integrations?workspaceId=${workspaceId}`);
      if (r.status === 403) {
        // Non-owner/admin members can configure campaigns but not inspect integrations.
        setForbidden(true);
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? `request failed (${r.status})`);
      setChecks(body as unknown as Check[]);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { void load(); }, [workspaceId]);

  if (forbidden) return null;
  if (checking && checks.length === 0) return <p style={{ color: "#9fb0c3" }}>Checking integrations…</p>;

  const tone = (s: string) => (s === "pass" ? "ok" : s === "fail" ? "bad" : "warn") as "ok" | "bad" | "warn";
  const actionFor = (c: Check) => {
    if (c.status === "fail") return " — Reconnect: update the provider key for this workspace, then Re-test below.";
    if (c.status === "not_configured") return " — Nothing was sent or changed. Add the provider key to enable this channel.";
    if (c.status === "warning") return " — Safe to continue; review before production use.";
    return "";
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Integrations</h2>
        <button onClick={load} disabled={checking} style={{ padding: "6px 12px", borderRadius: 8, background: "#5b6572", color: "#fff", border: 0, cursor: checking ? "not-allowed" : "pointer" }}>
          {checking ? "Testing…" : "Re-test"}
        </button>
      </div>
      <ErrorBox message={error} />
      {checks.length === 0 && !error ? (
        <EmptyState title="No integrations checked yet" body="Run the check to verify each configured provider. Nothing is sent or changed by checking." />
      ) : (
        checks.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid #1e2530", fontSize: 13 }}>
            <span style={{ width: 130, color: "#9fb0c3" }}>{c.kind}</span>
            <Badge tone={tone(c.status)}>{c.status.replace("_", " ").toUpperCase()}</Badge>
            <span>{c.provider}: {c.message}{actionFor(c)}</span>
          </div>
        ))
      )}
    </div>
  );
}
