import { db, J } from "./db";
import { getLLMProvider } from "./llm";
import { resolveModel } from "./models";
import { retrieveKnowledge, buildAuthorizedContext } from "./knowledge";
import { assertNoFabrication } from "./policy";

export type ProspectIntent =
  | "pricing_question" | "product_question" | "objection" | "meeting_request"
  | "demo_request" | "more_info" | "positive" | "negative"
  | "opt_out" | "handoff" | "unclear";

const INTENT_RULES: Array<[ProspectIntent, RegExp]> = [
  ["opt_out", /unsubscribe|remove me|do not (contact|email)|stop emailing|gdpr|delete my data/],
  ["meeting_request", /let'?s (meet|talk|chat|schedule)|book (a|time|meeting)|calendar|send (me )?(a )?(invite|link)|tuesday|wednesday|thursday|call (tomorrow|next week|friday)/],
  ["demo_request", /\bdemo\b|trial|pilot|proof of concept|walkthrough/],
  ["pricing_question", /how much|pricing|price|cost|quote|plan|tier|fee|charge|budget/],
  ["objection", /but |however|concern|risk|already (use|have)|locked in|contract|too expensive|not convinced|skeptic/],
  ["product_question", /how does|does it (do|support|integrate)|feature|integration|security|soc2|gdpr|api|support for|can it|do you (offer|have)/],
  ["more_info", /tell me more|more (info|information|details)|send (me )?(more|details|docs|documentation)|case stud|reference/],
  ["positive", /interested|sounds (good|great)|love (it|this)|let'?s explore|yes.*(call|meeting)|looking forward/],
  ["negative", /not interested|no thanks|pass|not a (fit|priority)|leave me alone|wrong (person|time)/],
  ["handoff", /manager|boss|someone (else|senior)|human|real person|call me|phone number/],
];

export function detectIntent(text: string): { intent: ProspectIntent; confidence: number } {
  const t = text.toLowerCase();
  for (const [intent, re] of INTENT_RULES) {
    if (re.test(t)) return { intent, confidence: 0.85 };
  }
  return { intent: "unclear", confidence: 0.4 };
}

export interface ConversationResult {
  reply: string;
  intent: ProspectIntent;
  confidence: number;
  knowledgeUsed: string[];
  handoff: boolean;
  approvalRequired: boolean;
}

// Conversational SDR: retrieve authorized knowledge → constrained draft → claim validation.
// Returns known | unknown | not-authorized | requires-human explicitly; never hallucinates.
export async function respondToProspect(leadId: string, prospectMessage: string): Promise<ConversationResult> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { campaign: true, contact: true, company: true } });
  if (!lead) throw new Error("lead not found");

  let convo = await db.conversation.findFirst({ where: { leadId, status: "open" } });
  if (!convo) {
    convo = await db.conversation.create({ data: { workspaceId: lead.workspaceId, leadId, status: "open" } });
  }
  await db.conversationMessage.create({
    data: { conversationId: convo.id, role: "prospect", body: prospectMessage.slice(0, 4000) },
  });

  const { intent, confidence } = detectIntent(prospectMessage);

  // Deterministic terminal intents first — no LLM needed.
  if (intent === "opt_out") {
    await db.conversation.update({ where: { id: convo.id }, data: { status: "opted_out", optedOut: true, intent } });
    await db.suppression.create({
      data: { workspaceId: lead.workspaceId, email: lead.contact?.email?.toLowerCase(), reason: "unsubscribed" },
    }).catch(() => undefined);
    await db.lead.update({ where: { id: leadId }, data: { status: "UNSUBSCRIBED" } }).catch(() => undefined);
    const reply = `Understood — I've removed you from this sequence. You won't hear from us again.`;
    await db.conversationMessage.create({ data: { conversationId: convo.id, role: "agent", body: reply, intent } });
    return { reply, intent, confidence, knowledgeUsed: [], handoff: false, approvalRequired: false };
  }

  const chunks = await retrieveKnowledge(lead.workspaceId, prospectMessage, { topK: 3 }).catch(() => []);
  const context = buildAuthorizedContext(chunks);
  const knowledgeUsed = chunks.map((c) => `${c.source}/${c.documentTitle}#${c.chunkId}`);

  let reply = "";
  let handoff = false;
  let approvalRequired = false;
  const mc = await resolveModel("conversation", lead.workspaceId);

  if (!chunks.length && (intent === "pricing_question" || intent === "product_question" || intent === "objection")) {
    // Unknown / not authorized → human, never invented.
    handoff = true; approvalRequired = true;
    reply = `Thanks for asking — I want to give you an accurate answer rather than guess. I've flagged this for ${lead.campaign.senderName ?? "our team"} to reply personally shortly.`;
  } else {
    const history = await db.conversationMessage.findMany({
      where: { conversationId: convo.id }, orderBy: { createdAt: "desc" }, take: 6,
    });
    const llm = getLLMProvider();
    try {
      const draft = await llm.generateText(
        `You are an SDR replying to a prospect. Prospect: ${lead.contact?.fullName} (${lead.contact?.title}) at ${lead.company?.name}. Intent: ${intent}. Their message: """${prospectMessage.slice(0, 1500)}"""\n\nAUTHORIZED KNOWLEDGE (only facts you may use):\n${context || "(none — keep it to process, offer a human follow-up)"}\n\nRecent thread:\n${history.reverse().map((m) => `${m.role}: ${m.body.slice(0, 300)}`).join("\n")}\n\nRules: answer ONLY from authorized knowledge. Never invent pricing, features, customers, or timelines. If the answer isn't in the knowledge, say you'll connect them with the team. Max 100 words, plain text.`,
        { model: mc.model, temperature: 0.3, tracking: { workspaceId: lead.workspaceId, campaignId: lead.campaignId, leadId, task: "conversation" } },
      );
      reply = draft.trim();
      assertNoFabrication(reply, chunks.map((c) => c.content));
    } catch {
      handoff = true; approvalRequired = true;
      reply = `Thanks — I've passed your question to ${lead.campaign.senderName ?? "our team"} for an accurate answer.`;
    }
    if (confidence < 0.65) { approvalRequired = true; handoff = true; }
  }

  await db.conversationMessage.create({
    data: { conversationId: convo.id, role: "agent", body: reply.slice(0, 4000), intent, knowledgeUsed: J(knowledgeUsed) },
  });
  await db.conversation.update({
    where: { id: convo.id },
    data: {
      intent, meetingIntent: intent === "meeting_request" || intent === "demo_request" ? true : undefined,
      handoffReason: handoff ? `intent=${intent} confidence=${confidence}` : undefined,
      knowledgeContext: J({ chunks: knowledgeUsed }), model: mc.model,
    },
  }).catch(() => undefined);

  return { reply, intent, confidence, knowledgeUsed, handoff, approvalRequired };
}
