import { auth } from "@/auth";
import { db } from "@/lib/db";
import { requireWorkspaces } from "@/lib/session";
import { redirect } from "next/navigation";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  const { workspaceIds } = await requireWorkspaces().catch(() => ({ userId: "", workspaceIds: [] as string[] }));
  const workspaces = await db.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, name: true } }).catch(() => []);
  return (
    <div>
      <h1>Settings</h1>
      <p style={{ color: "#9fb0c3" }}>Provider health per workspace. Checks are read-only — nothing is sent or changed. Secrets are encrypted at rest and never displayed.</p>
      {workspaces.length === 0 ? (
        <p style={{ color: "#9fb0c3" }}>No workspaces yet. <a href="/onboarding" style={{ color: "#7ea4ff" }}>Create one via onboarding →</a></p>
      ) : (
        <SettingsClient workspaces={workspaces} />
      )}
      <h2 style={{ marginTop: 32 }}>Environment reference</h2>
      <p style={{ color: "#9fb0c3", fontSize: 13 }}>Server-level defaults. Per-workspace provider credentials override these where configured.</p>
      <pre style={{ background: "#131a24", padding: 12, borderRadius: 8 }}>{`EMAIL_PROVIDER=resend|sendgrid|postmark|ses|smtp|console
LLM_DEFAULT_MODEL / LLM_STRONG_MODEL
APPROVAL_MODE_DEFAULT=assisted
DAILY_SEND_LIMIT_DEFAULT=50`}</pre>
    </div>
  );
}
