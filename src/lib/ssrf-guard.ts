import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard for server-side fetches built from database-stored hostnames
// (e.g. company domains researched by the agent). Resolves the hostname and
// refuses private/loopback/link-local targets before any HTTP request.
// Note: resolve-then-fetch has an inherent DNS-rebinding TOCTOU window; this
// blocks direct attacks (cloud metadata, intranet hosts, localhost) which is
// the realistic threat for workspace-supplied domains.
function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const b = ip.split(".").map(Number);
    if (b[0] === 10) return true;
    if (b[0] === 172 && b[1]! >= 16 && b[1]! <= 31) return true;
    if (b[0] === 192 && b[1] === 168) return true;
    if (b[0] === 127) return true;
    if (b[0] === 169 && b[1] === 254) return true;
    if (b[0] === 0) return true;
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    return false;
  }
  return true; // not an IP at all — refuse
}

export function isBlockedIpForTest(ip: string): boolean {
  return isBlockedIp(ip);
}

export async function isPublicHostname(hostname: string): Promise<boolean> {
  const host = hostname.trim().toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  try {
    const { address } = await lookup(host);
    return !isBlockedIp(address);
  } catch {
    return false; // unresolvable → do not fetch
  }
}
