import { z } from "zod";
import { db } from "@/lib/db";
import { calendarForWorkspace, bookMeeting, cancelBookedMeeting } from "@/lib/integrations";
import { emit } from "../agents/events";
import type { ToolContext, ToolDef } from "./registry";

export const checkCalendarAvailabilitySchema = z.object({
  leadId: z.string(), durationMin: z.number().min(15).max(120).default(30),
  from: z.string().optional(), to: z.string().optional(),
});

export async function checkCalendarAvailability(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId, durationMin, from, to } = args as { leadId: string; durationMin: number; from?: string; to?: string };
  const lead = await db.lead.findUnique({ where: { id: leadId as string }, include: { campaign: true } });
  if (!lead) throw new Error("lead not found");
  const cal = await calendarForWorkspace(lead.workspaceId);
  const slots = await cal.getAvailability({
    durationMin: durationMin as number,
    from: from as string | undefined, to: to as string | undefined,
    timezone: lead.campaign.timezone,
  });
  await emit("calendar.availability", `${slots.length} slots via ${cal.name}`, { leadId: lead.id, campaignId: lead.campaignId }, { count: slots.length });
  return { provider: cal.name, slots };
}

export const scheduleMeetingSchema = z.object({
  leadId: z.string(), start: z.string(), end: z.string(), title: z.string().optional(),
});

export async function scheduleMeetingTool(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { leadId, start, end, title } = args as { leadId: string; start: string; end: string; title?: string };
  const result = await bookMeeting({
    leadId: leadId as string, start: start as string, end: end as string,
    title: title as string | undefined,
  });
  await emit("meeting.booked", `Meeting ${result.id}`, { leadId: leadId as string }, result);
  return result;
}

export const cancelMeetingSchema = z.object({ meetingId: z.string() });

export async function cancelMeeting(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
  const { meetingId } = args as { meetingId: string };
  return cancelBookedMeeting(meetingId as string);
}

export const calendarTools: Record<string, ToolDef> = {
  checkCalendarAvailability: { schema: checkCalendarAvailabilitySchema, fn: checkCalendarAvailability, destructive: false },
  scheduleMeeting: { schema: scheduleMeetingSchema, fn: scheduleMeetingTool, destructive: true },
  cancelMeeting: { schema: cancelMeetingSchema, fn: cancelMeeting, destructive: true },
};
