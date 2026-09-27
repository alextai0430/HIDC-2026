import { z } from "zod";
import { identity, failure } from "@/lib/server";
import { tricks, deductions } from "@/lib/model";
const op = z.object({
  id: z.string().uuid(),
  competitor_id: z.string().uuid(),
  expected_version: z.number().int().nonnegative(),
  kind: z.enum(["put_event", "delete_event", "performance", "finish", "dq"]),
  payload: z.record(z.unknown()),
});
export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (profile.role !== "judge" || !profile.slot)
      throw new Error("Only assigned judges may submit scores");
    const input = op.parse(await req.json());
    let payload: unknown;
    if (input.kind === "put_event") {
      if (profile.slot > 3) throw new Error("Technical slot required");
      const e = z
        .object({
          id: z.string().uuid(),
          trick: z.string(),
          level: z.union([z.literal(0.5), z.number().int().min(1).max(10)]),
          features: z.array(z.enum(["T1", "T2", "T3", "A"])).max(4),
          at: z.string().datetime(),
        })
        .parse(input.payload);
      if (new Set(e.features).size !== e.features.length)
        throw new Error("Duplicate features");
      const [type, dimension] = e.trick.split(" ");
      if (!deductions.includes(e.trick) && !tricks[type]?.includes(dimension))
        throw new Error("Invalid trick");
      payload = e;
    } else if (input.kind === "delete_event") {
      if (profile.slot > 3) throw new Error("Technical slot required");
      payload = z.object({ id: z.string().uuid() }).parse(input.payload);
    } else if (input.kind === "performance") {
      if (profile.slot < 4) throw new Error("Performance slot required");
      payload = z
        .object({
          values: z.array(z.number().min(0).max(5).multipleOf(0.5)).length(6),
        })
        .parse(input.payload);
    } else if (input.kind === "finish")
      payload = z.object({ finished: z.boolean() }).parse(input.payload);
    else payload = z.object({ dq: z.boolean() }).parse(input.payload);
    const { data, error } = await client.rpc("apply_score", {
      p_user: profile.id,
      p_slot: profile.slot,
      p_id: input.id,
      p_competitor: input.competitor_id,
      p_version: input.expected_version,
      p_kind: input.kind,
      p_payload: payload,
    });
    if (error) throw new Error(error.message);
    return Response.json(data);
  } catch (e) {
    return failure(e);
  }
}
