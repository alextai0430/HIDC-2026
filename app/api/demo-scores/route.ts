import { eventScore, rankGlobal, total } from "@/lib/scoring";
import { Snapshot } from "@/lib/model";
import { canManage } from "@/lib/access";
import { DEFAULT_SCORING_RULES } from "@/lib/scoring-config";
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_BYPASS_AUTH !== "true")
    return Response.json({ error: "Demo scoring disabled" }, { status: 403 });
  try {
    const snapshot = (await req.json()) as Snapshot;
    const fullAccess = canManage(snapshot.profile);
    const submissions = fullAccess
      ? snapshot.submissions
      : snapshot.submissions.filter((s) => s.user_id === snapshot.profile.id);
    return Response.json(
      {
        submissions: submissions.map((s) => ({
          ...s,
          total: total(s, DEFAULT_SCORING_RULES),
          events: s.events.map((e) => ({ ...e, value: eventScore(e, DEFAULT_SCORING_RULES) })),
        })),
        ...(fullAccess
          ? { rankings: rankGlobal(snapshot.competitors, submissions, DEFAULT_SCORING_RULES) }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Invalid demo records" }, { status: 400 });
  }
}
