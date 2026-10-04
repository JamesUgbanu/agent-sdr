// Runs once at server boot (see `experimental.instrumentationHook`).
// Refuses production boot with publicly-known placeholder secrets so a copied
// `.env.example` can never silently secure a real deployment.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    for (const k of ["AUTH_SECRET", "ENCRYPTION_KEY"] as const) {
      const v = process.env[k] ?? "";
      if (!v || v.includes("change-me") || v.length < 32) {
        throw new Error(`[boot] ${k} must be set to a generated ≥32-char secret in production`);
      }
    }
  }
}
