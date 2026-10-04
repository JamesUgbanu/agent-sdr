export default function Settings() {
  return (
    <div>
      <h1>Settings</h1>
      <p style={{ color: "#9fb0c3" }}>Configure via environment + admin tables (model_configs, email/crm/calendar connections). Secrets encrypted at rest; workspace-isolated.</p>
      <pre style={{ background: "#131a24", padding: 12, borderRadius: 8 }}>{`EMAIL_PROVIDER=resend|sendgrid|postmark|ses|smtp|console
LLM_DEFAULT_MODEL / LLM_STRONG_MODEL
APPROVAL_MODE_DEFAULT=assisted
DAILY_SEND_LIMIT_DEFAULT=50`}</pre>
    </div>
  );
}
