import { z } from "zod";

export const WeightsSchema = z.object({
  companyFit: z.number().default(25),
  roleFit: z.number().default(20),
  geo: z.number().default(10),
  intent: z.number().default(20),
  signal: z.number().default(15),
  dataConfidence: z.number().default(10),
});
export type ScoringWeights = z.infer<typeof WeightsSchema>;

export interface ScoreInput {
  companyMatch: number; // 0..1
  roleMatch: number;
  geoMatch: number;
  intentMatch: number;
  signalStrength: number;
  dataConfidence: number;
}

export function scoreLead(input: ScoreInput, weights: ScoringWeights) {
  const factors = {
    companyFit: round(input.companyMatch * weights.companyFit),
    roleFit: round(input.roleMatch * weights.roleFit),
    geography: round(input.geoMatch * weights.geo),
    intent: round(input.intentMatch * weights.intent),
    recentSignal: round(input.signalStrength * weights.signal),
    dataConfidence: round(input.dataConfidence * weights.dataConfidence),
  };
  const score = Object.values(factors).reduce((a, b) => a + b, 0);
  return { score: Math.min(100, score), factors };
}
const round = (n: number) => Math.round(n * 10) / 10;
