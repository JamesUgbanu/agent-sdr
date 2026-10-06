import type { CSSProperties, ReactNode } from "react";

// Shared primitives: one visual language, accessible defaults, no framework.
export const colors = {
  bg: "#0b0e14",
  panel: "#131a24",
  card: "#10161f",
  border: "#1e2530",
  inputBorder: "#2a3444",
  inputBg: "#0f141c",
  text: "#e6e9ef",
  muted: "#9fb0c3",
  link: "#7ea4ff",
  ok: "#2f9e44",
  warn: "#e8b93e",
  warnBg: "#2a1a10",
  warnBorder: "#b7791f",
  bad: "#ff8080",
  accent: "#4f7cff",
  violet: "#9a6bff",
  gray: "#5b6572",
};

export function Btn({ bg = colors.accent, children, ...rest }: { bg?: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      style={{ padding: "8px 12px", borderRadius: 8, background: bg, color: "#fff", border: 0, cursor: rest.disabled ? "not-allowed" : "pointer", opacity: rest.disabled ? 0.6 : 1, marginRight: 8 }}
    >
      {children}
    </button>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 16, marginBottom: 16, background: colors.card, ...style }}>
      {children}
    </div>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  const map = {
    ok: { color: colors.ok, border: colors.ok },
    warn: { color: colors.warn, border: colors.warnBorder },
    bad: { color: colors.bad, border: colors.bad },
    info: { color: colors.muted, border: colors.border },
  } as const;
  const t = map[tone];
  return (
    <span style={{ color: t.color, border: `1px solid ${t.border}`, borderRadius: 20, padding: "1px 10px", fontSize: 12, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div style={{ border: `1px dashed ${colors.inputBorder}`, borderRadius: 10, padding: 24, color: colors.muted, marginBottom: 16 }}>
      <div style={{ color: colors.text, fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, marginBottom: action ? 12 : 0 }}>{body}</div>
      {action}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return <div role="alert" style={{ color: colors.bad, fontSize: 13, marginBottom: 8 }}>{message}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={{ display: "block", fontSize: 12, color: colors.muted, marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  padding: 10, borderRadius: 8, border: `1px solid ${colors.inputBorder}`,
  background: colors.inputBg, color: "#fff", width: "100%", marginBottom: 0,
};

export const preStyle: CSSProperties = { background: colors.bg, padding: 10, borderRadius: 8, overflow: "auto", fontSize: 12 };
