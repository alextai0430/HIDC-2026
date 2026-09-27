import { identity, protectedAccess, failure } from "@/lib/server";
import { eventScore, rankGlobal, total } from "@/lib/scoring";
import { Submission } from "@/lib/model";
import { canManage } from "@/lib/access";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const access = await protectedAccess(profile);
    const { data: competitors, error } = await client
      .from("competitors")
      .select("*")
      .order("position");
    if (error) throw error;
    let query = client.from("submissions").select("*");
    if (!access) query = query.eq("user_id", profile.id);
    const { data: subs, error: subError } = await query;
    if (subError) throw subError;
    const submissions = (subs ?? []) as Submission[];
    const own = submissions.filter(
      (s) =>
        s.user_id === profile.id &&
        s.finished &&
        !competitors!.find((c) => c.id === s.competitor_id)?.archived,
    );
    const personal = own.map((s) => ({
      competitor_id: s.competitor_id,
      rank: 1,
      ...(s.slot > 3 ? { total: total(s) } : {}),
    }));
    for (const division of new Set(competitors!.map((c) => c.division))) {
      const sorted = own
        .filter(
          (s) =>
            competitors!.find((c) => c.id === s.competitor_id)?.division ===
            division,
        )
        .sort((a, b) => Number(a.dq) - Number(b.dq) || total(b) - total(a));
      sorted.forEach((s, i) => {
        personal.find((p) => p.competitor_id === s.competitor_id)!.rank = i + 1;
      });
    }
    const divisionRows = await client.from("divisions").select("name");
    const result: Record<string, unknown> = {
      divisions: divisionRows.data?.map((d) => d.name),
      profile,
      competitors,
      protected: access,
      personal,
      submissions: submissions.map((s) => ({
        ...s,
        ...(access
          ? {
              total: total(s),
              events: s.events.map((e) => ({ ...e, value: eventScore(e) })),
            }
          : {}),
      })),
    };
    if (access) {
      const { data: audit } = await client
        .from("audit")
        .select("*")
        .order("id", { ascending: false })
        .limit(250);
      result.audit = audit;
    }
    if (canManage(profile)) {
      result.rankings = rankGlobal(competitors!, submissions);
      const profiles = (
        await client
          .from("profiles")
          .select("id,name,username,role,slot,active,is_admin")
          .order("slot")
      ).data;
      result.profiles = profiles;
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}
