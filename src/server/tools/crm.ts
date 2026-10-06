import { z } from "zod";
import { db } from "@/lib/db";
import { updateCRM } from "@/lib/integrations";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const updateCRMSchema = z.object({
  leadId: z.string(),
  operation: z.enum(["upsert_contact", "add_note", "create_deal", "create_activity"]).default("upsert_contact"),
  note: z.string().optional(), title: z.string().optional(),
  amount: z.number().optional(), stage: z.string().optional(),
  type: z.string().optional(), body: z.string().optional(),
});

export async function updateCRMTool(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId, operation, ...rest } = args as { leadId: string; operation: "upsert_contact" | "add_note" | "create_deal" | "create_activity"; [k: string]: unknown };
  const result = await updateCRM(leadId, operation, rest as Record<string, string | number | undefined>);
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  await emit("crm.synced", `${operation}: ${result.externalId ?? "ok"}`, { leadId, campaignId: lead?.campaignId }, result);
  return result;
}

export const crmTools: Record<string, ToolDef> = {
  updateCRM: { schema: updateCRMSchema, fn: updateCRMTool, destructive: false },
};
