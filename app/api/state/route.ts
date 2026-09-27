import { identity, failure } from "@/lib/server";
import { eventScore, rankGlobal, total } from "@/lib/scoring";
import { Submission } from "@/lib/model";
import { canManage } from "@/lib/access";
import { sanitizeAuditRows } from "@/lib/audit";
import { requestHasAdminUnlock } from "@/lib/admin-unlock";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const fullAccess = canManage(profile);
    const revealPoints = requestHasAdminUnlock(req, profile.id);
    const { data: allCompetitors, error } = await client
      .from("competitors")
      .select("*")
      .order("position");
    if (error) throw error;
    let query = client.from("submissions").select("*");
    if (!fullAccess) query = query.eq("user_id", profile.id);
    const { data: subs, error: subError } = await query;
    if (subError) throw subError;
    const databaseSubmissions = (subs ?? []) as Submission[];
    const submissions = revealPoints
      ? databaseSubmissions
      : databaseSubmissions.map((submission) => ({
          ...submission,
          performance: [],
          events: submission.events.map(({ value: _value, ...event }) => event),
        }));
    const own = submissions.filter(
      (s) =>
        s.user_id === profile.id &&
        s.finished &&
        !allCompetitors!.find((c) => c.id === s.competitor_id)?.archived,
    );
    const personal = own.map((s) => ({
      competitor_id: s.competitor_id,
      rank: 1,
      ...(revealPoints && s.slot > 3 ? { total: total(s) } : {}),
    }));
    for (const division of new Set(allCompetitors!.map((c) => c.division))) {
      const sorted = own
        .filter(
          (s) =>
            allCompetitors!.find((c) => c.id === s.competitor_id)?.division ===
            division,
        )
        .sort((a, b) => Number(a.dq) - Number(b.dq) || total(b) - total(a));
      sorted.forEach((s, i) => {
        personal.find((p) => p.competitor_id === s.competitor_id)!.rank = i + 1;
      });
    }
    const divisionRows = await client.from("divisions").select("name");
    const ownProfile = await withAvatar(client, profile);
    let assignmentsQuery = client.from("division_judges").select("division,slot,user_id");
    if (!fullAccess) assignmentsQuery = assignmentsQuery.eq("user_id", profile.id);
    let assignmentRows = await assignmentsQuery;
    const assignmentsMissing = ["42P01", "PGRST205"].includes(assignmentRows.error?.code ?? "");
    // Compatibility while an existing deployment is waiting for migration 006.
    if (assignmentsMissing) {
      assignmentRows = {
        data: [...new Set(allCompetitors!.map((c: any) => c.division))].map((division) =>
          ({ division, slot: profile.slot, user_id: profile.id })),
        error: null,
      } as any;
      if (fullAccess) assignmentRows.data = [];
    }
    if (assignmentRows.error) throw assignmentRows.error;
    const assignments = assignmentRows.data ?? [];
    const assignedDivisionIds = new Set(assignments.filter((a: any) => a.user_id === profile.id).map((a: any) => a.division));
    const ownCompetitorIds = new Set(submissions.map((s) => s.competitor_id));
    const competitors = fullAccess
      ? allCompetitors!
      : allCompetitors!.filter((c: any) =>
          ownCompetitorIds.has(c.id) || (c.status === "active" && assignedDivisionIds.has(c.division)),
        );
    const result: Record<string, unknown> = {
      divisions: divisionRows.data?.map((d) => d.name),
      profile: ownProfile,
      competitors,
      protected: fullAccess,
      pointAccess: revealPoints,
      personal,
      submissions: submissions.map((s) => {
        if (!revealPoints) {
          const { total: _total, ...withoutTotal } = s;
          return withoutTotal;
        }
        return {
          ...s,
          total: total(s),
          events: s.events.map((e) => ({ ...e, value: eventScore(e) })),
        };
      }),
      assignments,
    };
    if (fullAccess) {
      const { data: audit } = await client
        .from("audit")
        .select("*")
        .order("id", { ascending: false })
        .limit(250);
      const safeAudit = sanitizeAuditRows(audit ?? []);
      result.audit = revealPoints
        ? safeAudit
        : safeAudit.map((row) =>
            [
              "put_event",
              "delete_event",
              "performance",
              "finish",
              "dq",
              "admin_review",
            ].includes(row.action)
              ? { ...row, prior: { redacted: true }, next: { redacted: true } }
              : row,
          );
    }
    if (fullAccess) {
      if (revealPoints)
        result.rankings = rankGlobal(allCompetitors!, submissions);
      result.competitors = allCompetitors;
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
      if (assignmentsMissing) {
        const judges = (profiles ?? []).filter((p: any) => p.role === "judge" && p.active);
        result.assignments = (divisionRows.data ?? []).flatMap((d: any) =>
          judges.map((p: any) => ({ division: d.name, slot: p.slot, user_id: p.id })),
        );
      }
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
