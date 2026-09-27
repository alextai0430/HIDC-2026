import { z } from "zod";
import { canManageScoringConfiguration } from "@/lib/access";
import { requestHasAdminUnlock } from "@/lib/admin-unlock";
import { failure, identity } from "@/lib/server";
import {
  calculateScoringConfigurationImpact,
  loadScoringConfiguration,
  scoringRulesSchema,
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
    return Response.json(
      { revision: config.revision, dataRevision: config.dataRevision, rules: config.rules },
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
      const { submissions, competitors } = await loadImpactData(client);
      const impact = calculateScoringConfigurationImpact(
        config.rules,
        input.rules,
        submissions,
        competitors,
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
    const { submissions, competitors } = await loadImpactData(client);
    const currentImpact = calculateScoringConfigurationImpact(
      config.rules,
      input.rules,
      submissions,
      competitors,
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
  if (!requestHasAdminUnlock(req, profile.id)) {
    return Response.json({ error: "Unlock the Admin tab before opening technical point configuration." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

function migrationRequired() {
  return Response.json(
    { error: "Apply Supabase migration 007 before using Technical Point Configuration." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function loadImpactData(client: any): Promise<{ submissions: Submission[]; competitors: Competitor[] }> {
  const [scoreQuery, competitorQuery] = await Promise.all([
    client.from("submissions").select("id,competitor_id,slot,events,finished,dq,performance,version,updated_at").lte("slot", 3),
    client.from("competitors").select("id,name,division,position,status,dq,archived").order("position"),
  ]);
  if (scoreQuery.error) throw new Error(scoreQuery.error.message);
  if (competitorQuery.error) throw new Error(competitorQuery.error.message);
  return {
    submissions: (scoreQuery.data ?? []) as Submission[],
    competitors: (competitorQuery.data ?? []) as Competitor[],
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
