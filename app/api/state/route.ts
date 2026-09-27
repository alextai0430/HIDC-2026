import { identity, failure } from "@/lib/server";
import { eventScore, rankGlobal, total } from "@/lib/scoring";
import { Submission } from "@/lib/model";
import { canManage } from "@/lib/access";
import { sanitizeAuditRows } from "@/lib/audit";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const fullAccess = canManage(profile);
    const { data: competitors, error } = await client
      .from("competitors")
      .select("*")
      .order("position");
    if (error) throw error;
    let query = client.from("submissions").select("*");
    if (!fullAccess) query = query.eq("user_id", profile.id);
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
    const ownProfile = await withAvatar(client, profile);
    const result: Record<string, unknown> = {
      divisions: divisionRows.data?.map((d) => d.name),
      profile: ownProfile,
      competitors,
      protected: fullAccess,
      personal,
      submissions: submissions.map((s) => ({
        ...s,
        total: total(s),
        events: s.events.map((e) => ({ ...e, value: eventScore(e) })),
      })),
    };
    if (fullAccess) {
      const { data: audit } = await client
        .from("audit")
        .select("*")
        .order("id", { ascending: false })
        .limit(250);
      result.audit = sanitizeAuditRows(audit ?? []);
    }
    if (fullAccess) {
      result.rankings = rankGlobal(competitors!, submissions);
      let roster: any = await client
        .from("profiles")
        .select("id,name,username,role,slot,active,is_admin,avatar_path")
        .order("slot");
      // Keep the app usable against deployments until migration 005 is applied.
      if (roster.error?.code === "42703")
        roster = await client
          .from("profiles")
          .select("id,name,username,role,slot,active,is_admin")
          .order("slot");
      if (roster.error) throw roster.error;
      const profiles = roster.data;
      result.profiles = await Promise.all(
        (profiles ?? []).map((item: Record<string, any>) => withAvatar(client, item)),
      );
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

async function withAvatar(client: any, value: Record<string, any>) {
  const { avatar_path: path, ...safe } = value;
  const avatar = path
    ? await client.storage
        .from("profile-avatars")
        .createSignedUrl(path, 60 * 60)
    : null;
  if (avatar?.error) throw avatar.error;
  return { ...safe, avatar_url: avatar?.data?.signedUrl ?? null };
}
