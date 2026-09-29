import { isAssignedJudge } from "@/lib/access";
import { z } from "zod";
import { identity, failure } from "@/lib/server";
import { executionOptions, tricks, deductions } from "@/lib/model";
import { loadScoringConfiguration } from "@/lib/scoring-config";
const op = z.object({
  id: z.string().uuid(),
  competitor_id: z.string().uuid(),
  expected_version: z.number().int().nonnegative(),
  kind: z.enum(["put_event", "delete_event", "performance", "finish", "dq"]),
  payload: z.record(z.unknown()),
  scoring_window_revision: z.string().uuid(),
  scoring_window_token: z.string().uuid(),
});
export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (!isAssignedJudge(profile))
      throw new Error("Only assigned judges may submit scores");
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      !((raw as Record<string, unknown>).scoring_window_revision) ||
      !((raw as Record<string, unknown>).scoring_window_token)) {
      return Response.json({
        error: "This queued score predates scoring-window authorization. It remains saved locally; ask the organizer to reopen the competitor so you can reconcile it.",
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const input = op.parse(raw);
    let payload: unknown;
    if (input.kind === "put_event") {
      const e = z
        .object({
          id: z.string().uuid(),
          trick: z.string(),
          level: z.union([z.literal(0.5), z.number().int().min(1).max(10)]),
          features: z.array(z.enum(["T1", "T2", "T3", "A"])).max(4),
          execution: z.enum(executionOptions).default("E0"),
          at: z.string().datetime(),
        })
        .parse(input.payload);
      if (new Set(e.features).size !== e.features.length)
        throw new Error("Duplicate features");
      const [type, dimension] = e.trick.split(" ");
      if (!deductions.includes(e.trick) && !tricks[type]?.includes(dimension))
        throw new Error("Invalid trick");
      if (deductions.includes(e.trick) && e.execution !== "E0")
        throw new Error("Execution adjustments cannot be applied to deductions");
      payload = e;
    } else if (input.kind === "delete_event") {
      payload = z.object({ id: z.string().uuid() }).parse(input.payload);
    } else if (input.kind === "performance") {
      payload = z
        .object({
          values: z.array(z.number().min(0).max(5).multipleOf(0.5)).length(6),
        })
        .parse(input.payload);
    } else if (input.kind === "finish")
      payload = z.object({ finished: z.literal(true) }).parse(input.payload);
    else payload = z.object({ dq: z.boolean() }).parse(input.payload);
    const { data, error } = await client.rpc("apply_score", {
      p_user: profile.id,
      // Legacy RPC argument; the server resolves assignment order from this competitor's division.
      p_slot: 1,
      p_id: input.id,
      p_competitor: input.competitor_id,
      p_version: input.expected_version,
      p_kind: input.kind,
      p_payload: payload,
      p_window_revision: input.scoring_window_revision,
      p_window_token: input.scoring_window_token,
    });
    if (error) throw new Error(error.message);
    const scoringConfiguration = await loadScoringConfiguration(client);
    return Response.json({
      ...(data && typeof data === "object" ? data : { ok: true }),
      scoringConfigRevision: scoringConfiguration.revision,
    });
  } catch (e) {
    return failure(e);
  }
}
