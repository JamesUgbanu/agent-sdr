import { channelForProvider } from "../src/lib/email";
import { ApolloProvider, HunterProvider, PeopleDataLabsProvider } from "../src/lib/prospect-providers";
import { verificationProvider } from "../src/lib/integrations";

async function main() {
  // Every adapter must fail loudly without credentials — never fake success.
  const cases: Array<[string, () => Promise<unknown>]> = [
    ["resend.send", () => channelForProvider("resend").send({ to: "a@b.com", subject: "s", body: "b", idempotencyKey: "p1" })],
    ["sendgrid.send", () => channelForProvider("sendgrid").send({ to: "a@b.com", subject: "s", body: "b", idempotencyKey: "p2" })],
    ["postmark.send", () => channelForProvider("postmark").send({ to: "a@b.com", subject: "s", body: "b", idempotencyKey: "p3" })],
    ["ses.send", () => channelForProvider("ses").send({ to: "a@b.com", subject: "s", body: "b", idempotencyKey: "p4" })],
    ["smtp.send", () => channelForProvider("smtp").send({ to: "a@b.com", subject: "s", body: "b", idempotencyKey: "p5" })],
    ["apollo.companies", () => new ApolloProvider("").searchCompanies({ query: "x" })],
    ["hunter.contacts", () => new HunterProvider("").searchContacts({ companyDomain: "x.com" })],
    ["pdl.companies", () => new PeopleDataLabsProvider("").searchCompanies({ query: "x" })],
  ];
  for (const [n, fn] of cases) {
    // strip keys to prove credential-required behavior
    for (const k of ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_API_KEY", "AWS_ACCESS_KEY_ID", "APOLLO_API_KEY", "HUNTER_API_KEY", "PDL_API_KEY", "SMTP_URL"]) delete (process.env as Record<string, string | undefined>)[k];
    try { await fn(); console.log("FAIL (no error):", n); process.exitCode = 1; }
    catch (e) {
      const ok = /not configured/i.test(String(e));
      console.log(ok ? "PASS" : "FAIL", n, "—", (String(e).split("\n")[0] ?? "").slice(0, 80));
      if (!ok) process.exitCode = 1;
    }
  }
  const v = await verificationProvider().verify("someone@example.com");
  console.log(v.status === "unavailable" ? "PASS neverbounce.unavailable" : "FAIL neverbounce", v.status);
  if (v.status !== "unavailable") process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode ?? 0));
