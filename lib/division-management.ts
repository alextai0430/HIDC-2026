import type { Competitor, Profile, Submission } from "./model";

export type DivisionAssignment = {
  division: string;
  slot: number;
  user_id: string;
  scoring_type: "technical" | "performance";
};

export type DivisionJudge = {
  slot: number;
  user_id: string;
  scoring_type: "technical" | "performance";
  name: string;
  username?: string;
};

export type CompetitorJudgeProgress = DivisionJudge & {
  status: "Pending" | "Scoring" | "Submitted" | "Reopened";
};

export type CompetitorProgress = {
  competitor: Competitor;
  entries: CompetitorJudgeProgress[];
  complete: boolean;
  started: boolean;
};

type JudgeSnapshot = {
  competitor_id: string;
  user_id: string;
  scoring_type: "technical" | "performance";
  roster_order: number;
  display_name: string;
  role_snapshot: string;
  expected: boolean;
};

export function divisionRosterIsValid(
  assignments: Pick<DivisionAssignment, "slot" | "scoring_type">[],
) {
  return assignments.length >= 2 && assignments.length <= 10 &&
    assignments.every((row, index) => row.slot === index + 1) &&
    assignments.some((row) => row.scoring_type === "technical") &&
    assignments.some((row) => row.scoring_type === "performance");
}

export function divisionCompetitors(
  competitors: Competitor[],
  division: string,
) {
  return competitors
    .filter((competitor) => competitor.division === division)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function divisionJudgeRoster(
  division: string,
  competitors: Competitor[],
  assignments: DivisionAssignment[],
  judgeRoster: JudgeSnapshot[],
  profiles: Profile[],
): DivisionJudge[] {
  const competitorIds = new Set(
    competitors.filter((competitor) => competitor.division === division).map((competitor) => competitor.id),
  );
  const snapshots = judgeRoster.filter((row) => competitorIds.has(row.competitor_id) && row.expected);
  const rows = snapshots.length
    ? snapshots.map((row) => ({
        slot: row.roster_order,
        user_id: row.user_id,
        scoring_type: row.scoring_type,
        name: profiles.find((profile) => profile.id === row.user_id)?.name ?? row.display_name ?? "Former Judge",
        username: profiles.find((profile) => profile.id === row.user_id)?.username,
      }))
    : assignments.filter((row) => row.division === division).map((row) => {
        const profile = profiles.find((candidate) => candidate.id === row.user_id);
        return {
          slot: row.slot,
          user_id: row.user_id,
          scoring_type: row.scoring_type,
          name: profile?.name ?? "Former Judge",
          username: profile?.username,
        };
      });
  const unique = new Map<string, DivisionJudge>();
  for (const row of rows) {
    const key = `${row.slot}:${row.scoring_type}:${row.user_id}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()].sort((a, b) => a.slot - b.slot);
}

export function competitorProgress(
  competitor: Competitor,
  assignments: DivisionAssignment[],
  judgeRoster: JudgeSnapshot[],
  submissions: Submission[],
  profiles: Profile[],
): CompetitorProgress {
  const official = judgeRoster.filter((row) => row.competitor_id === competitor.id && row.expected);
  const judges: DivisionJudge[] = official.length
    ? official.map((row) => ({
        slot: row.roster_order,
        user_id: row.user_id,
        scoring_type: row.scoring_type,
        name: profiles.find((profile) => profile.id === row.user_id)?.name ?? row.display_name ?? "Former Judge",
        username: profiles.find((profile) => profile.id === row.user_id)?.username,
      }))
    : assignments.filter((row) => row.division === competitor.division).map((row) => {
        const profile = profiles.find((candidate) => candidate.id === row.user_id);
        return {
          slot: row.slot,
          user_id: row.user_id,
          scoring_type: row.scoring_type,
          name: profile?.name ?? "Former Judge",
          username: profile?.username,
        };
      });
  const entries = judges.sort((a, b) => a.slot - b.slot).map((judge) => {
    const submission = submissions.find((row) =>
      row.competitor_id === competitor.id &&
      (row.user_id === judge.user_id || row.historical_user_id === judge.user_id) &&
      row.scoring_type === judge.scoring_type,
    );
    const status: CompetitorJudgeProgress["status"] = submission?.finished
      ? "Submitted"
      : submission && submission.version > 1
        ? "Reopened"
        : submission && submission.version > 0
          ? "Scoring"
          : "Pending";
    return { ...judge, status };
  });
  const complete = divisionRosterIsValid(entries) && entries.every((entry) => entry.status === "Submitted");
  return {
    competitor,
    entries,
    complete,
    started: entries.some((entry) => entry.status !== "Pending"),
  };
}
