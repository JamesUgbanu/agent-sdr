// Runs once at server boot (see `experimental.instrumentationHook`).
// Refuses production boot on invalid configuration so a misconfigured
// deployment fails loudly instead of running half-broken. Secrets are never
// logged — only key names.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { checkConfig } = await import("./src/lib/config-check");
    const errors = checkConfig(process.env, true).filter((i) => i.level === "error");
    if (errors.length > 0) {
      throw new Error(`[boot] invalid production configuration: ${errors.map((e) => e.key).join(", ")}`);
    }
  }
}
