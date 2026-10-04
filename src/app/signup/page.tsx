"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await fetch("/api/auth/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    if (!r.ok) {
      setMsg((await r.json()).error ?? "Signup failed");
      return;
    }
    await signIn("credentials", { email, password, callbackUrl: "/" });
  };
  return (
    <div style={{ maxWidth: 360 }}>
      <h1>Sign up</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={i} />
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={i} />
        <input placeholder="Password (min 10 chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={i} />
        <button style={b}>Create account</button>
      </form>
      {msg && <p style={{ color: "#ff8080" }}>{msg}</p>}
      <p style={{ color: "#9fb0c3" }}><a href="/login" style={{ color: "#7ea4ff" }}>Sign in</a></p>
    </div>
  );
}
const i: React.CSSProperties = { padding: 10, borderRadius: 8, border: "1px solid #2a3444", background: "#0f141c", color: "#fff" };
const b: React.CSSProperties = { padding: 10, borderRadius: 8, background: "#4f7cff", color: "#fff", border: 0, cursor: "pointer" };
