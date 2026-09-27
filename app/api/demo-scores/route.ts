import { adminProtectionEnabled } from "@/lib/access";
import { eventScore, rankGlobal, total } from "@/lib/scoring";
import { Snapshot } from "@/lib/model";
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_BYPASS_AUTH !== "true" || adminProtectionEnabled)
    return Response.json({ error: "Demo scoring disabled" }, { status: 403 });
  try {
    const snapshot = (await req.json()) as Snapshot;
    return Response.json(
      {
        submissions: snapshot.submissions.map((s) => ({
          ...s,
          total: total(s),
          events: s.events.map((e) => ({ ...e, value: eventScore(e) })),
        })),
        rankings: rankGlobal(snapshot.competitors, snapshot.submissions),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Invalid demo records" }, { status: 400 });
  }
}
