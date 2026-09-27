import { z } from "zod";
import { identity, failure } from "@/lib/server";
import { canManage } from "@/lib/access";
export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (!canManage(profile)) throw new Error("Administrator access required");
    const p = z
      .object({
        id: z.string().uuid(),
        version: z.number().int().nonnegative(),
        finished: z.boolean(),
        dq: z.boolean(),
      })
      .parse(await req.json());
    const { error } = await client.rpc("review_submission", {
      p_actor: profile.id,
      p_id: p.id,
      p_version: p.version,
      p_finished: p.finished,
      p_dq: p.dq,
    });
    if (error) throw new Error(error.message);
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
