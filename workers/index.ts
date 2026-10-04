import { registerHandler } from "@/lib/queue";
import { runAgent } from "@/server/agents/orchestrator";
import fs from "node:fs";

// Liveness heartbeat for the Docker healthcheck: refreshed on every successful
// consumer-loop pass (including idle polls). A sustained Redis/processing
// failure skips the heartbeat, so the container reports unhealthy.
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/worker-heartbeat";
function heartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch { /* ephemeral; never crash the worker over observability */ }
}

registerHandler("prospecting", async (p) => {
  const { campaignId } = p as { campaignId: string };
  await runAgent("prospecting", { campaignId }, { campaignId });
});
registerHandler("enrichment", async (p) => {
  const { campaignId, leadId } = p as { campaignId?: string; leadId?: string };
  if (leadId) await runAgent("research", { leadId }, { leadId });
  else if (campaignId) {
    const { db } = await import("@/lib/db");
    const leads = await db.lead.findMany({ where: { campaignId, status: "NEW" }, take: 25 });
    for (const l of leads) await runAgent("research", { leadId: l.id }, { campaignId, leadId: l.id });
  }
});
registerHandler("qualification", async (p) => {
  const { leadId } = p as { leadId: string };
  await runAgent("qualification", { leadId }, { leadId });
});
registerHandler("personalization", async (p) => {
  const { leadId } = p as { leadId: string };
  await runAgent("personalization", { leadId, step: 0 }, { leadId });
});
registerHandler("outreach", async (p) => {
  const { messageId, leadId } = p as { messageId?: string; leadId?: string };
  if (messageId) await runAgent("outreach", { messageId }, { leadId });
  if (leadId) {
    const { syncLeadToCRM } = await import("@/lib/integrations");
    await syncLeadToCRM(leadId, "Outreach sent").catch((e) => console.error("[crm-sync]", e));
  }
});
registerHandler("reply", async (p) => {
  const { messageId, leadId } = p as { messageId: string; leadId?: string };
  await runAgent("reply", { messageId }, { leadId });
});
registerHandler("meeting", async (p) => {
  const { leadId } = p as { leadId: string };
  const { handleMeetingRequest } = await import("@/lib/integrations");
  if (leadId) await handleMeetingRequest(leadId);
});
registerHandler("conversation", async (p) => {
  const { leadId, prospectMessage } = p as { leadId?: string; prospectMessage?: string };
  if (leadId && prospectMessage) await runAgent("conversation", { leadId, prospectMessage }, { leadId });
});
registerHandler("followup", async (p) => {
  const { leadId } = p as { leadId?: string };
  if (leadId) await runAgent("followup", { leadId }, { leadId });
});
registerHandler("crm", async (p) => {
  const { leadId } = p as { leadId?: string };
  if (leadId) await runAgent("crm", { leadId }, { leadId });
});

console.log("[worker] handlers registered: prospecting, enrichment, qualification, personalization, outreach, reply, meeting");

// Redis consumer: BRPOP each known queue + promote due delayed jobs.
// Without REDIS_URL, enqueue() dispatches in-process (dev/test).
let running = true;
async function consumeRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("[worker] no REDIS_URL — in-process dispatch mode");
    return;
  }
  const { default: Redis } = await import("ioredis");
  const r = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await r.connect();
  console.log("[worker] redis consumer connected");
  const { processRedisMessage } = await import("@/lib/queue");
  while (running) {
    try {
      // promote due delayed jobs on ANY delayed queue (dynamic discovery)
      const delayedKeys = await r.keys("sdr:delayed:*");
      for (const dk of delayedKeys) {
        const due = await r.zrangebyscore(dk, 0, Date.now());
        const q = dk.replace("sdr:delayed:", "sdr:queue:");
        for (const msg of due) {
          await r.zrem(dk, msg);
          await r.lpush(q, msg);
        }
      }
      // consume from ALL live queues (dynamic — no hardcoded list to drift)
      const queueKeys = await r.keys("sdr:queue:*");
      const res = await r.brpop(queueKeys.length ? queueKeys : ["sdr:queue:__idle__"], 5);
      if (res && (res as string[])[0] !== "sdr:queue:__idle__") {
        const [, raw] = res as [string, string];
        const key = (res as string[])[0]!.replace("sdr:queue:", "");
        await processRedisMessage(key, raw);
      }
      heartbeat();
    } catch (e) {
      console.error("[worker] consumer error:", String(e).slice(0, 200));
      await new Promise((r2) => setTimeout(r2, 2000));
    }
  }
  r.disconnect();
  console.log("[worker] consumer stopped gracefully");
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received — draining`);
    running = false;
    setTimeout(() => process.exit(0), 8000);
  });
}

void consumeRedis();
