"use client";
import { useState } from "react";
import { IntegrationStatus } from "./IntegrationStatus";

export default function SettingsClient({ workspaces }: { workspaces: Array<{ id: string; name: string }> }) {
  const [wsId, setWsId] = useState(workspaces[0]?.id ?? "");
  return (
    <div>
      <label style={{ display: "block", fontSize: 12, color: "#9fb0c3", marginBottom: 4 }}>
        Workspace
        <select
          aria-label="Workspace"
          value={wsId}
          onChange={(e) => setWsId(e.target.value)}
          style={{ display: "block", marginTop: 4, padding: 10, borderRadius: 8, border: "1px solid #2a3444", background: "#0f141c", color: "#fff", maxWidth: 480 }}
        >
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      {wsId && <IntegrationStatus key={wsId} workspaceId={wsId} />}
    </div>
  );
}
