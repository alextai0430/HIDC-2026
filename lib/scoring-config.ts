import { z } from "zod";
import { tricks } from "./model";
import type { Competitor, Execution, ScoringConfiguration, ScoringRules, Submission } from "./model";
import { eventScore } from "./scoring";

// Server routes and tests only. Do not import point values into client code.
export const DEFAULT_SCORING_RULES: ScoringRules = {
  bases: {
    "#": { "2D": 0.7, "3D": 6, "4D": 15 },
    T: { "1D": 0.1, "2D": 1, "3D": 6, "4D": 12, VD: 0.2 },
    O: { "1D": 0.2, "2D": 1.2, "3D": 4, "4D": 8, VD: 0.5 },
    F: { "2D": 1.5, "3D": 5, "4D": 10 },
    S: { "1D": 0.1, "2D": 1, "3D": 6, "4D": 12, VD: 0.2 },
    W: { "1D": 0.2, VD: 0.4 },
    R: { "1D": 0.4, "2D": 1.2, "3D": 6, "4D": 12, VD: 1 },
  },
  deductions: {
    "Unintentional Drop": -0.3,
    Tangle: -0.5,
    "Time Violation": -2,
    "Other Rule Violation": -2,
  },
  levels: {
    "0.5": 0.5,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
  },
  features: { T1: 1.7, T2: 3, T3: 5, A: 1.7 },
  executions: { E0: 1, "E-1": 0.9, "E-2": 0.8, "E-3": 0.7 },
};

const defaultExecutions: Record<Execution, number> = DEFAULT_SCORING_RULES.executions;

const nonnegative = z.number().finite().min(0).max(1000);
const positiveMultiplier = z.number().finite().min(0.01).max(100);
const negativeDeduction = z.number().finite().min(-1000).max(0);
const dimensions = (available: string[]) =>
  z.object(Object.fromEntries(available.map((dimension) => [dimension, nonnegative]))).strict();

export const scoringRulesSchema = z.object({
  bases: z.object(Object.fromEntries(
    Object.entries(tricks).map(([category, available]) => [category, dimensions(available)]),
  )).strict(),
  deductions: z.object({
    "Unintentional Drop": negativeDeduction,
    Tangle: negativeDeduction,
    "Time Violation": negativeDeduction,
    "Other Rule Violation": negativeDeduction,
  }).strict(),
  levels: z.object({
    "0.5": positiveMultiplier,
    "1": positiveMultiplier,
    "2": positiveMultiplier,
    "3": positiveMultiplier,
    "4": positiveMultiplier,
    "5": positiveMultiplier,
    "6": positiveMultiplier,
    "7": positiveMultiplier,
    "8": positiveMultiplier,
    "9": positiveMultiplier,
    "10": positiveMultiplier,
  }).strict(),
  features: z.object({
    T1: positiveMultiplier,
    T2: positiveMultiplier,
    T3: positiveMultiplier,
    A: positiveMultiplier,
  }).strict(),
  // Defaults let existing revisions/config rows (created before execution
  // scoring existed) continue to load as E0 / Normal.
  executions: z.object({
    E0: positiveMultiplier,
    "E-1": positiveMultiplier,
    "E-2": positiveMultiplier,
    "E-3": positiveMultiplier,
  }).strict().default(defaultExecutions),
}).strict();

export function validateScoringRules(value: unknown): ScoringRules {
  return scoringRulesSchema.parse(value) as ScoringRules;
}

export function missingScoringConfigurationSchema(error: { code?: string } | null | undefined) {
  return ["42P01", "PGRST205"].includes(error?.code ?? "");
}

export async function loadScoringConfiguration(client: any): Promise<ScoringConfiguration & { storageReady: boolean }> {
  const { data, error } = await client
    .from("scoring_configuration")
    .select("revision,data_revision,rules")
    .eq("config_id", "global")
    .maybeSingle();
  if (missingScoringConfigurationSchema(error)) {
    return { revision: 1, dataRevision: 1, rules: DEFAULT_SCORING_RULES, storageReady: false };
  }
  if (error) throw new Error(error.message ?? "Could not load technical point rules.");
  if (!data) throw new Error("Global technical point configuration is missing.");
  const storageReady = !!data.rules && typeof data.rules === "object" &&
    !!(data.rules as Record<string, unknown>).executions;
  return {
    revision: Number(data.revision),
    dataRevision: Number(data.data_revision ?? 1),
    rules: validateScoringRules(data.rules),
    storageReady,
  };
}

export type ScoringConfigurationImpact = {
  technicalSubmissions: number;
  technicalEventValues: number;
  competitors: number;
  rankingDivisions: number;
  finalizedRankings: number;
};

export function calculateScoringConfigurationImpact(
  oldRules: ScoringRules,
  newRules: ScoringRules,
  submissions: Submission[],
  competitors: Competitor[],
  assignments?: { division: string; slot: number; user_id: string; scoring_type?: "technical" | "performance" }[],
): ScoringConfigurationImpact {
  const competitorById = new Map(competitors.map((competitor) => [competitor.id, competitor]));
  const affectedSubmissionIds = new Set<string>();
  const directlyAffectedCompetitors = new Set<string>();
  let technicalEventValues = 0;

  for (const submission of submissions) {
    if ((submission.scoring_type ?? (submission.slot <= 3 ? "technical" : "performance")) !== "technical") continue;
    for (const event of submission.events) {
      if (eventScore(event, oldRules) === eventScore(event, newRules)) continue;
      technicalEventValues++;
      affectedSubmissionIds.add(submission.id);
      directlyAffectedCompetitors.add(submission.competitor_id);
    }
  }

  const rankingDivisions = new Set(
    [...directlyAffectedCompetitors]
      .map((id) => competitorById.get(id))
      .filter((competitor) => competitor && !competitor.archived && competitor.division !== "Exhibition")
      .map((competitor) => competitor!.division),
  );
  const finalizedCompetitors = new Set<string>();
  for (const division of rankingDivisions) {
    const divisionCompetitors = competitors.filter(
      (competitor) => competitor.division === division && !competitor.archived,
    );
    for (const competitor of divisionCompetitors) {
      const judges = assignments?.filter((assignment) => assignment.division === division)
        ?? [...new Map(submissions
          .filter((submission) => competitorById.get(submission.competitor_id)?.division === division)
          .map((submission) => [submission.user_id, { user_id: submission.user_id }])).values()];
      const finishedJudges = new Set(submissions
        .filter((submission) => submission.competitor_id === competitor.id && submission.finished)
        .map((submission) => submission.user_id));
      if (judges.length >= 2 && judges.every((judge) => finishedJudges.has(judge.user_id))) {
        finalizedCompetitors.add(competitor.id);
      }
    }
  }

  return {
    technicalSubmissions: affectedSubmissionIds.size,
    technicalEventValues,
    competitors: new Set([...directlyAffectedCompetitors, ...finalizedCompetitors]).size,
    rankingDivisions: rankingDivisions.size,
    finalizedRankings: finalizedCompetitors.size,
  };
}
