"use client";
import { useEffect, useState } from "react";
import { Btn, ErrorBox, Field, inputStyle } from "./ui";

export function CampaignForm({ workspaces }: { workspaces: Array<{ id: string; name: string }> }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [name, setName] = useState("");
  const [offer, setOffer] = useState("");
  const [jobTitles, setJobTitles] = useState("CTO, VP Engineering");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setCreated("");
    try {
      const r = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          name,
          offer: offer || undefined,
          jobTitles: jobTitles.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string; id?: string };
      if (!r.ok) throw new Error(body.error ?? `request failed (${r.status})`);
      setCreated("Campaign created — prospecting starts automatically. Watch Agent Activity for progress.");
      setName("");
      setOffer("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (workspaces.length === 0) {
    return <p style={{ color: "#9fb0c3" }}>Create a workspace first (see <a href="/onboarding" style={{ color: "#7ea4ff" }}>Onboarding</a>), then return here to create a campaign.</p>;
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 480 }} aria-label="Create campaign">
      <Field label="Workspace">
        <select aria-label="Workspace" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} style={inputStyle}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </Field>
      <Field label="Campaign name">
        <input aria-label="Campaign name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="US SaaS CTO Outreach" style={inputStyle} />
      </Field>
      <Field label="Offer">
        <input aria-label="Offer" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="Offer, e.g. AI automation implementation" style={inputStyle} />
      </Field>
      <Field label="Job titles (comma-separated)">
        <input aria-label="Job titles" value={jobTitles} onChange={(e) => setJobTitles(e.target.value)} placeholder="CTO, VP Engineering" style={inputStyle} />
      </Field>
      <ErrorBox message={error} />
      {created && <div role="status" style={{ color: "#2f9e44", fontSize: 13 }}>{created}</div>}
      <div><Btn disabled={busy || !workspaceId || !name.trim()}>{busy ? "Creating…" : "Create campaign"}</Btn></div>
    </form>
  );
}
