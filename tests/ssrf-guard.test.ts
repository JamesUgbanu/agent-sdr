import { describe, it, expect } from "vitest";
import { isBlockedIpForTest, isPublicHostname } from "../src/lib/ssrf-guard";

describe("ssrf guard: blocked ranges", () => {
  it("blocks loopback, private, link-local, and metadata ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1"]) {
      expect(isBlockedIpForTest(ip), ip).toBe(true);
    }
  });
  it("allows public addresses and rejects non-IPs", () => {
    expect(isBlockedIpForTest("8.8.8.8")).toBe(false);
    expect(isBlockedIpForTest("1.1.1.1")).toBe(false);
    expect(isBlockedIpForTest("not-an-ip")).toBe(true);
  });
  it("blocks 172.15.x and 172.32.x (outside the 172.16/12 private range)", () => {
    expect(isBlockedIpForTest("172.15.0.1")).toBe(false);
    expect(isBlockedIpForTest("172.32.0.1")).toBe(false);
  });
});

describe("ssrf guard: hostnames", () => {
  it("blocks localhost and internal suffixes without DNS", async () => {
    expect(await isPublicHostname("localhost")).toBe(false);
    expect(await isPublicHostname("db.localhost")).toBe(false);
    expect(await isPublicHostname("svc.internal")).toBe(false);
    expect(await isPublicHostname("")).toBe(false);
  });
});
