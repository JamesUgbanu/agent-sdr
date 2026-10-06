// Usage: npx tsx scripts/check-config.ts [--strict]
// Exit 0 when no errors; exit 1 with a summary otherwise. Never prints values.
import { checkConfig } from "../src/lib/config-check";

const strict = process.argv.includes("--strict") || process.env.NODE_ENV === "production";
const issues = checkConfig(process.env, strict);
for (const i of issues) {
  console.log(`${i.level.toUpperCase().padEnd(7)} ${i.key}: ${i.message}`);
}
const errors = issues.filter((i) => i.level === "error").length;
if (errors > 0) {
  console.log(`\nconfig-check: ${errors} error(s) — refusing to continue`);
  process.exit(1);
}
console.log(`\nconfig-check: OK (${issues.length} warning(s))`);
