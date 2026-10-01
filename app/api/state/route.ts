import { identity, failure } from "@/lib/server";
import { rankGlobal, total } from "@/lib/scoring";
import { Submission } from "@/lib/model";
import { canManage } from "@/lib/access";
import { sanitizeAuditRows } from "@/lib/audit";
import { requestHasPointAccess } from "@/lib/admin-unlock";
import { loadScoringConfiguration } from "@/lib/scoring-config";
import { stateSubmissionForProfile } from "@/lib/scoped";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const fullAccess = canManage(profile);
    const revealPoints = requestHasPointAccess(req, profile.id);
    const scoringConfiguration = await loadScoringConfiguration(client);
    const { data: allCompetitors, error } = await client
      .from("competitors")
      .select("*")
      .order("position");
    if (error) throw error;
    let query = client.from("submissions").select("*");
    if (!fullAccess) query = query.eq("user_id", profile.id);
    const { data: subs, error: subError } = await query;
    if (subError) throw subError;
    const databaseSubmissions = ((subs ?? []) as Submission[]).map((submission) =>
      fullAccess && !submission.user_id
        ? { ...submission, user_id: submission.historical_user_id ?? "deleted-judge" }
        : submission,
    );
    const submissions = databaseSubmissions.map((submission) =>
      stateSubmissionForProfile(
        profile,
        submission,
        revealPoints,
        scoringConfiguration.rules,
      ),
    );
    const own = submissions.filter(
      (s) =>
        s.user_id === profile.id &&
        s.finished &&
        !allCompetitors!.find((c) => c.id === s.competitor_id)?.archived,
    );
    const personal = own.map((s) => ({
      competitor_id: s.competitor_id,
      rank: 1,
      ...(revealPoints ? { total: total(s, scoringConfiguration.rules) } : {}),
    }));
    for (const division of new Set(allCompetitors!.map((c) => c.division))) {
      const sorted = own
        .filter(
          (s) =>
            allCompetitors!.find((c) => c.id === s.competitor_id)?.division ===
            division,
        )
        .sort((a, b) => Number(a.dq) - Number(b.dq) || total(b, scoringConfiguration.rules) - total(a, scoringConfiguration.rules));
      sorted.forEach((s, i) => {
        personal.find((p) => p.competitor_id === s.competitor_id)!.rank = i + 1;
      });
    }
    const divisionRows = await client.from("divisions").select("name");
    const ownProfile = await withAvatar(client, profile);
    let assignmentsQuery = client.from("division_judges").select("division,slot,user_id,scoring_type");
    if (!fullAccess) assignmentsQuery = assignmentsQuery.eq("user_id", profile.id);
    const assignmentRows = await assignmentsQuery;
    if (assignmentRows.error) throw assignmentRows.error;
    const currentAssignments = assignmentRows.data ?? [];
    const rosterQuery = await client.from("competitor_judges")
      .select("competitor_id,user_id,scoring_type,roster_order,display_name,role_snapshot,expected");
    if (rosterQuery.error) throw rosterQuery.error;
    const judgeRoster = (rosterQuery.data ?? []) as NonNullable<import("@/lib/model").Snapshot["judgeRoster"]>;
    const visibleRoster = fullAccess ? judgeRoster : judgeRoster.filter((row) => row.user_id === profile.id);
    const assignments = fullAccess
      ? currentAssignments
      : (() => {
          const byDivision = new Map<string, { division: string; slot: number; user_id: string; scoring_type: "technical" | "performance" }>();
          for (const assignment of currentAssignments as any[]) byDivision.set(assignment.division, assignment);
          for (const row of visibleRoster) {
            const competitor = allCompetitors!.find((candidate: any) => candidate.id === row.competitor_id);
            if (competitor && !byDivision.has(competitor.division)) byDivision.set(competitor.division, {
              division: competitor.division, slot: row.roster_order, user_id: profile.id, scoring_type: row.scoring_type,
            });
          }
          return [...byDivision.values()];
        })();
    const assignedDivisionIds = new Set(visibleRoster
      .filter((row) => row.user_id === profile.id && row.expected)
      .map((row) => allCompetitors!.find((competitor: any) => competitor.id === row.competitor_id)?.division)
      .filter(Boolean));
    const ownCompetitorIds = new Set(submissions.map((s) => s.competitor_id));
    const competitors = fullAccess
      ? allCompetitors!
      : allCompetitors!.filter((c: any) =>
          ownCompetitorIds.has(c.id) || (c.status === "active" && assignedDivisionIds.has(c.division)),
        );
    const activeCompetitor = allCompetitors!.find((competitor: any) => competitor.status === "active" && !competitor.archived);
    let scoringWindow: unknown = null;
    if (activeCompetitor) {
      const issued = await client.rpc("issue_scoring_window", { p_user: profile.id, p_competitor: activeCompetitor.id });
      if (issued.error) throw issued.error;
      scoringWindow = issued.data;
    }
    const result: Record<string, unknown> = {
      divisions: divisionRows.data?.map((d) => d.name),
      profile: ownProfile,
      competitors,
      protected: fullAccess,
      pointAccess: revealPoints,
      scoringConfigRevision: scoringConfiguration.revision,
      personal,
      submissions,
      assignments,
      scoringWindow,
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
              "scoring_configuration_update",
            ].includes(row.action)
              ? { ...row, prior: { redacted: true }, next: { redacted: true } }
              : row,
          );
    }
    if (fullAccess) {
      if (revealPoints)
        result.rankings = rankGlobal(allCompetitors!, submissions, scoringConfiguration.rules, assignments, judgeRoster);
      result.judgeRoster = judgeRoster;
      result.competitors = allCompetitors;
      let roster: any = await client
        .from("profiles")
        .select("id,name,username,role,active,is_admin,archived,avatar_path")
        .order("name");
      // Read the former global slot only from an older database during migration rollout.
      if (roster.error?.code === "42703")
        roster = await client.from("profiles")
          .select("id,name,username,role,slot,active,is_admin,avatar_path")
          .order("name");
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
