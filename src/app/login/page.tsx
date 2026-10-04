"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const r = await signIn("credentials", { email, password, redirect: false });
    if (r?.error) setError("Invalid email or password");
    else location.href = "/";
  };
  return (
    <div style={{ maxWidth: 360 }}>
      <h1>Sign in</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={i} />
        <input placeholder="Password (min 10 chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={i} />
        {error && <div style={{ color: "#ff8080" }}>{error}</div>}
        <button style={b}>Sign in</button>
      </form>
      <p style={{ color: "#9fb0c3" }}>No account? <a href="/signup" style={{ color: "#7ea4ff" }}>Sign up</a></p>
    </div>
  );
}
const i: React.CSSProperties = { padding: 10, borderRadius: 8, border: "1px solid #2a3444", background: "#0f141c", color: "#fff" };
const b: React.CSSProperties = { padding: 10, borderRadius: 8, background: "#4f7cff", color: "#fff", border: 0, cursor: "pointer" };
