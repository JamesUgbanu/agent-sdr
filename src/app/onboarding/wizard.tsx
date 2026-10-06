"use client";
import { useEffect, useState } from "react";

// Client onboarding wizard: workspace → integrations → knowledge → campaign → preflight.
// Each step calls the real APIs; integration rows show live verify status.
type Step = "workspace" | "integrations" | "knowledge" | "campaign" | "preflight" | "done";

const INTEGRATION_LABELS: Record<string, string> = {
  email: "Email provider", prospecting: "Prospecting", verification: "Verification",
  crm: "CRM", calendar: "Calendar", llm: "LLM provider",
};

export default function OnboardingWizard() {
  const [step, setStep] = useState<Step>("workspace");
  const [wsId, setWsId] = useState("");
  const [wsName, setWsName] = useState("");
  const [checks, setChecks] = useState<Array<{ provider: string; kind: string; status: string; message: string }>>([]);
  const [checking, setChecking] = useState(false);
  const [kbTitle, setKbTitle] = useState("");
  const [kbContent, setKbContent] = useState("");
  const [campName, setCampName] = useState("");
  const [preflight, setPreflight] = useState<{ verdict?: string; checks?: Array<{ label: string; status: string; detail: string }> }>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Persist progress so refresh/navigation never loses the workspace.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("sdr-onboarding");
      if (saved) {
        const p = JSON.parse(saved) as { wsId?: string; step?: Step };
        if (p.wsId) {
          setWsId(p.wsId);
          if (p.step && p.step !== "workspace") setStep(p.step);
        }
      }
    } catch { /* corrupted storage — start fresh */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("sdr-onboarding", JSON.stringify({ wsId, step }));
    } catch { /* storage unavailable — progress simply won't persist */ }
  }, [wsId, step]);

  const STEPS: Array<{ id: Step; label: string }> = [
    { id: "workspace", label: "Workspace" },
    { id: "integrations", label: "Integrations" },
    { id: "knowledge", label: "Knowledge" },
    { id: "campaign", label: "Campaign" },
    { id: "preflight", label: "Preflight" },
    { id: "done", label: "Done" },
  ];
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  function goBack() {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1]!.id);
  }

  async function api(path: string, init?: RequestInit) {
    const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body as { error?: string }).error ?? `request failed (${r.status})`);
    return body;
  }

  async function createWorkspace() {
    setBusy(true); setError("");
    try {
      const ws = (await api("/api/workspaces", { method: "POST", body: JSON.stringify({ name: wsName }) })) as { id: string };
      setWsId(ws.id);
      setStep("integrations");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function runChecks() {
    setChecking(true); setError("");
    try {
      const rows = (await api(`/api/admin/integrations?workspaceId=${wsId}`)) as typeof checks;
      setChecks(rows);
    } catch (e) { setError(String(e)); } finally { setChecking(false); }
  }

  useEffect(() => { if (wsId && step === "integrations") void runChecks(); }, [wsId, step]);

  async function saveKnowledge() {
    setBusy(true); setError("");
    try {
      await api("/api/knowledge", { method: "POST", body: JSON.stringify({ workspaceId: wsId, source: "playbook", sourceKind: "playbook", title: kbTitle, content: kbContent }) });
      setStep("campaign");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function createCampaign() {
    setBusy(true); setError("");
    try {
      await api("/api/campaigns", { method: "POST", body: JSON.stringify({ workspaceId: wsId, name: campName, targetIndustries: ["SaaS"], jobTitles: ["CTO"] }) });
      setStep("preflight");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function runPreflight() {
    setBusy(true); setError("");
    try {
      const r = (await api("/api/admin/deliverability", { method: "POST", body: JSON.stringify({ workspaceId: wsId }) })) as typeof preflight;
      setPreflight(r);
      setStep("done");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  const statusColor = (s: string) => s === "pass" ? "#2f9e44" : s === "fail" ? "#ff8080" : "#e8b93e";
  const box: React.CSSProperties = { maxWidth: 640 };
  const input: React.CSSProperties = { padding: 10, borderRadius: 8, border: "1px solid #2a3444", background: "#0f141c", color: "#fff", width: "100%", marginBottom: 8 };
  const btn: React.CSSProperties = { padding: "10px 16px", borderRadius: 8, background: "#4f7cff", color: "#fff", border: 0, cursor: "pointer", marginRight: 8 };
  const backBtn: React.CSSProperties = { ...btn, background: "#5b6572" };
  const Back = () => stepIndex > 0 ? <button style={backBtn} onClick={goBack} disabled={busy}>← Back</button> : null;

  return (
    <div style={box}>
      <h1>Client onboarding</h1>
      {error && <p role="alert" style={{ color: "#ff8080" }}>{error}</p>}
      <ol aria-label="Onboarding progress" style={{ display: "flex", gap: 6, padding: 0, listStyle: "none", flexWrap: "wrap", marginBottom: 20 }}>
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={s.id === step ? "step" : undefined}
            style={{
              fontSize: 12, padding: "4px 10px", borderRadius: 20,
              border: "1px solid",
              borderColor: i < stepIndex ? "#2f9e44" : i === stepIndex ? "#4f7cff" : "#2a3444",
              color: i <= stepIndex ? "#e6e9ef" : "#9fb0c3",
            }}
          >
            {i < stepIndex ? "✓ " : ""}{i + 1}. {s.label}
          </li>
        ))}
      </ol>

      {step === "workspace" && (
        <section><h2>1. Workspace</h2>
          <input aria-label="Client workspace name" style={input} placeholder="Client workspace name" value={wsName} onChange={(e) => setWsName(e.target.value)} />
          <button style={btn} disabled={busy || !wsName} onClick={createWorkspace}>Create workspace</button>
        </section>
      )}

      {step === "integrations" && (
        <section>
          <h2>2. Integrations {checking ? "(testing…)" : ""}</h2>
          <p style={{ color: "#9fb0c3" }}>Configure provider keys in <code>.env.{`{client}`}</code>, then re-run checks. Optional integrations may stay unconfigured.</p>
          {Object.entries(INTEGRATION_LABELS).map(([kind, label]) => {
            const row = checks.find((c) => c.kind === kind) ?? checks.find((c) => c.provider === kind);
            return (
              <div key={kind} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid #1e2530" }}>
                <span style={{ width: 140 }}>{label}</span>
                <span style={{ color: row ? statusColor(row.status) : "#9fb0c3" }}>{row ? `${row.status.toUpperCase()} — ${row.provider}: ${row.message}` : "…"}</span>
              </div>
            );
          })}
          <div style={{ marginTop: 12 }}>
            <button style={btn} onClick={runChecks} disabled={checking}>Re-test</button>
            <button style={btn} onClick={() => setStep("knowledge")}>Continue to knowledge →</button>
            <Back />
          </div>
        </section>
      )}

      {step === "knowledge" && (
        <section><h2>3. Knowledge / playbook</h2>
          <p style={{ color: "#9fb0c3" }}>Paste the client's offer, pricing, and objection handling. Chunked, versioned, and retrievable.</p>
          <input aria-label="Document title" style={input} placeholder="Document title, e.g. Pricing" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} />
          <textarea aria-label="Playbook content" style={{ ...input, minHeight: 140 }} placeholder="Paste playbook content…" value={kbContent} onChange={(e) => setKbContent(e.target.value)} />
          <button style={btn} disabled={busy || kbContent.length < 10} onClick={saveKnowledge}>Save knowledge</button>
          <Back />
        </section>
      )}

      {step === "campaign" && (
        <section><h2>4. First campaign</h2>
          <input aria-label="Campaign name" style={input} placeholder="Campaign name" value={campName} onChange={(e) => setCampName(e.target.value)} />
          <button style={btn} disabled={busy || !campName} onClick={createCampaign}>Create campaign</button>
          <Back />
        </section>
      )}

      {step === "preflight" && (
        <section><h2>5. Deliverability preflight</h2>
          <p style={{ color: "#9fb0c3" }}>Required before autonomous sending. FAIL blocks autonomy; WARNING is visible but non-blocking.</p>
          <button style={btn} disabled={busy} onClick={runPreflight}>Run preflight</button>
          <Back />
        </section>
      )}

      {step === "done" && (
        <section><h2>Onboarding complete — verdict: {preflight.verdict}</h2>
          {(preflight.checks ?? []).map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, padding: "4px 0" }}>
              <span style={{ color: statusColor(c.status), width: 90 }}>{c.status.toUpperCase()}</span>
              <span>{c.label} — {c.detail}</span>
            </div>
          ))}
          <p style={{ color: "#9fb0c3" }}>Workspace ID: <code>{wsId}</code></p>
        </section>
      )}
    </div>
  );
}
