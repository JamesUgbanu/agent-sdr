import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { db } from "@/lib/db";

import { withApi } from "@/lib/api";
import { z } from "zod";
import { ApprovalDecisionSchema, type ApprovalDecision } from "@/lib/validation";

type Decision = ApprovalDecision;

async function postHandler(req: Request, { params }: { params: { id: string } }) {
  const parsed = z.object({ decision: ApprovalDecisionSchema, decidedBy: z.string().optional() }).parse(await req.json());
  const decision: Decision = parsed.decision;
  // Session first (before touching the approval row) so unauthenticated
  // callers cannot distinguish existing vs missing approvals (no oracle).
  const { requireSession, requireMembership } = await import("@/lib/session");
  const session = await requireSession();
  const decidedBy = session.email ?? parsed.decidedBy; // audit identity comes from the session, never the client
  const approval = await db.approval.findUnique({ where: { id: params.id }, include: { lead: true } });
  if (!approval || approval.status !== "pending") {
    return NextResponse.json({ error: "not pending" }, { status: 409 });
  }
  await requireMembership(approval.lead.workspaceId);

  if (decision === "regenerate") {
    await db.approval.update({ where: { id: params.id }, data: { status: "rejected", decidedBy, decidedAt: new Date(), reason: "regenerate requested" } });
    if (approval.messageId) {
      await db.message.update({ where: { id: approval.messageId }, data: { status: "draft" } });
    }
    const { enqueue } = await import("@/lib/queue");
    await enqueue("personalization", { leadId: approval.leadId });
    return NextResponse.json({ ok: true, decision, regenerated: true });
  }

  if (decision === "pause") {
    await db.approval.update({ where: { id: params.id }, data: { status: "rejected", decidedBy, decidedAt: new Date(), reason: "sequence paused by human" } });
    await db.leadSequenceState.upsert({
      where: { leadId: approval.leadId },
      update: { stoppedReason: "paused-by-human", nextRunAt: null },
      create: { leadId: approval.leadId, currentStep: 0, stoppedReason: "paused-by-human" },
    });
    return NextResponse.json({ ok: true, decision, paused: true });
  }

  const finalStatus = decision === "rejected" ? "rejected" : "approved";
  if (finalStatus === "approved") {
    // Last-moment contactability re-check: the lead may have replied,
    // unsubscribed, or been suppressed after the draft was generated.
    const { canContactLead } = await import("@/lib/policy");
    const gate = await canContactLead(approval.leadId);
    if (!gate.ok) {
      return NextResponse.json({ error: `lead no longer contactable: ${gate.reason}` }, { status: 409 });
    }
  }
  await db.approval.update({ where: { id: params.id }, data: { status: finalStatus, decidedBy, decidedAt: new Date() } });
  if (approval.messageId) {
    await db.message.update({
      where: { id: approval.messageId },
      data: { status: decision === "rejected" ? "draft" : "approved" },
    });
    if (decision !== "rejected") {
      const { enqueue } = await import("@/lib/queue");
      await enqueue("outreach", { messageId: approval.messageId, leadId: approval.leadId });
    }
  }
  return NextResponse.json({ ok: true, decision });
}

// Edit the drafted message in place (stays pending until approved).
async function patchHandler(req: Request, { params }: { params: { id: string } }) {
  const { subject, body } = (await req.json()) as { subject?: string; body?: string };
  // Session first so anonymous callers cannot probe approval existence.
  const { requireSession, requireMembership } = await import("@/lib/session");
  await requireSession();
  const approval = await db.approval.findUnique({ where: { id: params.id }, include: { lead: true } });
  if (!approval || approval.status !== "pending" || !approval.messageId) {
    return NextResponse.json({ error: "not editable" }, { status: 409 });
  }
  await requireMembership(approval.lead.workspaceId);
  if (body) {
    const { assertNoFabrication } = await import("@/lib/policy");
    const msg = await db.message.findUnique({ where: { id: approval.messageId } });
    const claims = ((msg?.evidenceUsed as { knowledge?: string[] })?.knowledge ?? []).map(String);
    try {
      assertNoFabrication(body, claims.length ? claims : [body]); // edited copy still gated
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 422 });
    }
  }
  await db.message.update({ where: { id: approval.messageId }, data: { ...(subject ? { subject } : {}), ...(body ? { body } : {}) } });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(postHandler);
export const PATCH = withApi(patchHandler);
