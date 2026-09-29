import { z } from "zod";
import { canManageScoringConfiguration } from "@/lib/access";
import { requestHasPointAccess } from "@/lib/admin-unlock";
import { failure, identity } from "@/lib/server";
import {
  calculateScoringConfigurationImpact,
  loadScoringConfiguration,
  scoringRulesSchema,
  validateScoringRules,
} from "@/lib/scoring-config";
import type { Competitor, Profile, Submission } from "@/lib/model";

const impactSchema = z.object({
  technicalSubmissions: z.number().int().nonnegative(),
  technicalEventValues: z.number().int().nonnegative(),
  competitors: z.number().int().nonnegative(),
  rankingDivisions: z.number().int().nonnegative(),
  finalizedRankings: z.number().int().nonnegative(),
}).strict();
const revisionSchema = z.number().int().positive();
const confirmPhrase = "UPDATE POINT VALUES";

export async function GET(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const denied = authorizationFailure(req, profile);
    if (denied) return denied;
    const config = await loadScoringConfiguration(client);
    if (!config.storageReady) return migrationRequired();
    const { data: revisions, error: historyError } = await client
      .from("audit")
      .select("created_at,prior")
      .eq("action", "scoring_configuration_update")
      .order("id", { ascending: false })
      .limit(25);
    if (historyError) throw new Error(historyError.message);
    const previousRevisions = (revisions ?? []).flatMap((row: any) => {
      const revision = Number(row.prior?.revision);
      if (!Number.isInteger(revision) || revision < 1 || revision >= config.revision || !row.prior?.rules) return [];
      try {
        return [{ revision, updatedAt: row.created_at ?? null, rules: validateScoringRules(row.prior.rules) }];
      } catch {
        return [];
      }
    }).filter((entry: { revision: number }, index: number, all: { revision: number }[]) =>
      all.findIndex((candidate) => candidate.revision === entry.revision) === index,
    );
    return Response.json(
      { revision: config.revision, dataRevision: config.dataRevision, rules: config.rules, previousRevisions },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const denied = authorizationFailure(req, profile);
    if (denied) return denied;

    const raw = await req.json();
    const action = z.object({ action: z.enum(["preview", "update"]) }).parse(raw).action;
    const config = await loadScoringConfiguration(client);
    if (!config.storageReady) return migrationRequired();

    if (action === "preview") {
      const input = z.object({
        action: z.literal("preview"),
        expectedRevision: revisionSchema,
        rules: scoringRulesSchema,
      }).strict().parse(raw);
      if (input.expectedRevision !== config.revision) {
        return Response.json(
          { error: "Point values changed on the server. Reload the configuration before previewing again." },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      const { submissions, competitors, assignments, judgeRoster } = await loadImpactData(client);
      const impact = calculateScoringConfigurationImpact(
        config.rules,
        input.rules,
        submissions,
        competitors,
        assignments,
        judgeRoster,
      );
      return Response.json(
        { revision: config.revision, dataRevision: config.dataRevision, impact, unchanged: sameJson(config.rules, input.rules) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const input = z.object({
      action: z.literal("update"),
      expectedRevision: revisionSchema,
      expectedDataRevision: revisionSchema,
      rules: scoringRulesSchema,
      impact: impactSchema,
      confirmation: z.literal(confirmPhrase),
    }).strict().parse(raw);
    if (input.expectedRevision !== config.revision) {
      return Response.json(
        { error: "Point values changed on the server. Review a fresh impact summary before confirming." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (input.expectedDataRevision !== config.dataRevision) {
      return Response.json(
        { error: "Saved scores or competitors changed on the server. Review a fresh impact summary before confirming." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const { submissions, competitors, assignments, judgeRoster } = await loadImpactData(client);
    const currentImpact = calculateScoringConfigurationImpact(
      config.rules,
      input.rules,
      submissions,
      competitors,
      assignments,
      judgeRoster,
    );
    if (!sameJson(input.impact, currentImpact)) {
      return Response.json(
        { error: "Saved scores changed after the impact summary. Cancel and preview the update again." },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (sameJson(config.rules, input.rules)) {
      return Response.json({
        changed: false,
        revision: config.revision,
        rules: config.rules,
        impact: currentImpact,
      });
    }

    const { data, error } = await client.rpc("update_scoring_configuration", {
      p_actor: profile.id,
      p_expected_revision: config.revision,
      p_expected_data_revision: config.dataRevision,
      p_rules: input.rules,
      p_impact: currentImpact,
    });
    if (error) {
      if (error.message?.includes("configuration changed")) {
        return Response.json(
          { error: "Point values changed on the server. Review a fresh impact summary before confirming." },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      if (error.message?.includes("scoring data changed")) {
        return Response.json(
          { error: "Saved scores or competitors changed on the server. Review a fresh impact summary before confirming." },
          { status: 409, headers: { "Cache-Control": "no-store" } },
        );
      }
      throw new Error(error.message);
    }
    return Response.json(
      data && typeof data === "object"
        ? { ...data, dataRevision: data.data_revision }
        : data,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

function authorizationFailure(req: Request, profile: Profile) {
  if (!canManageScoringConfiguration(profile)) {
    return Response.json({ error: "Technical point configuration access denied." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!requestHasPointAccess(req, profile.id)) {
    return Response.json({ error: "Unlock Admin and turn on Show Points before opening technical point configuration." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

function migrationRequired() {
  return Response.json(
    { error: "The required scoring-configuration schema is unavailable. Apply all pending Supabase migrations before editing technical values." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function loadImpactData(client: any): Promise<{
  submissions: Submission[];
  competitors: Competitor[];
  assignments: { division: string; slot: number; user_id: string; scoring_type?: "technical" | "performance" }[];
  judgeRoster?: { competitor_id: string; user_id: string; scoring_type: "technical" | "performance"; expected: boolean }[];
}> {
  let [scoreQuery, competitorQuery, assignmentQuery, rosterQuery] = await Promise.all([
    client.from("submissions").select("id,competitor_id,user_id,historical_user_id,slot,scoring_type,events,finished,dq,performance,version,updated_at"),
    client.from("competitors").select("id,name,division,position,status,dq,archived").order("position"),
    client.from("division_judges").select("division,slot,user_id,scoring_type"),
    client.from("competitor_judges").select("competitor_id,user_id,scoring_type,expected"),
  ]);
  if (["42703", "PGRST204"].includes(scoreQuery.error?.code ?? ""))
    scoreQuery = await client.from("submissions").select("id,competitor_id,user_id,slot,scoring_type,events,finished,dq,performance,version,updated_at");
  if (["42703", "PGRST204"].includes(assignmentQuery.error?.code ?? ""))
    assignmentQuery = await client.from("division_judges").select("division,slot,user_id");
  if (["42P01", "PGRST205"].includes(rosterQuery.error?.code ?? "")) rosterQuery = { data: null, error: null };
  if (["42703", "PGRST204"].includes(scoreQuery.error?.code ?? ""))
    scoreQuery = await client.from("submissions").select("id,competitor_id,user_id,slot,scoring_type,events,finished,dq,performance,version,updated_at");
  if (["42703", "PGRST204"].includes(scoreQuery.error?.code ?? ""))
    scoreQuery = await client.from("submissions").select("id,competitor_id,user_id,slot,events,finished,dq,performance,version,updated_at");
  if (scoreQuery.error) throw new Error(scoreQuery.error.message);
  if (competitorQuery.error) throw new Error(competitorQuery.error.message);
  if (assignmentQuery.error) throw new Error(assignmentQuery.error.message);
  if (rosterQuery.error) throw new Error(rosterQuery.error.message);
  return {
    submissions: (scoreQuery.data ?? []) as Submission[],
    competitors: (competitorQuery.data ?? []) as Competitor[],
    assignments: assignmentQuery.data ?? [],
    judgeRoster: rosterQuery.data ?? undefined,
  };
}

function sameJson(left: unknown, right: unknown) {
  return canonical(left) === canonical(right);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
