import { z } from "zod";

export const CampaignSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  targetGeography: z.string().optional(),
  targetIndustries: z.array(z.string()).default([]),
  companySizeMin: z.number().int().optional(),
  companySizeMax: z.number().int().optional(),
  jobTitles: z.array(z.string()).default([]),
  technologies: z.array(z.string()).default([]),
  revenueRange: z.string().optional(),
  fundingStage: z.string().optional(),
  intentCriteria: z.string().optional(),
  offer: z.string().optional(),
  valueProposition: z.string().optional(),
  channels: z.array(z.string()).default(["email"]),
  approvalPolicy: z.enum(["manual", "assisted", "autonomous"]).default("assisted"),
  dailySendLimit: z.number().int().min(1).max(1000).default(50),
  timezone: z.string().default("UTC"),
  minScoreToContact: z.number().int().min(0).max(100).default(60),
});

export const ApprovalDecisionSchema = z.enum(["approved", "rejected", "regenerate", "pause", "send"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const EvidenceSchema = z.object({
  source_url: z.string(),
  source_type: z.string(),
  retrieved_at: z.string(),
  claim: z.string(),
  confidence: z.number().min(0).max(1),
});

export const PersonalizedMessageSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(10),
  personalization_points: z.array(z.string()),
  evidence_used: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  cta: z.string(),
});

export const ReplyClassificationSchema = z.object({
  classification: z.enum([
    "interested", "meeting_request", "question", "not_interested",
    "unsubscribe", "out_of_office", "wrong_person", "referral",
    "pricing_question", "objection", "unclear",
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  requiresHuman: z.boolean(),
});
