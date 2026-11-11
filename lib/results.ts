import { categories, deductions, executionLabels, type Competitor, type Event, type Ranking, type Submission } from "./model";

export type ScoringType = "technical" | "performance";
export type ResultsJudge = {
  user_id: string;
  scoring_type: ScoringType;
  roster_order: number;
};
export type ResultsView = "overall" | "technical" | "performance" | `judge:${ScoringType}:${string}`;
export type ResultsRow = Ranking & { viewScore: number | null; viewRank: number | null };
export type ScoreDetailsJudgeRow = {
  judge: ResultsJudge;
  submission: Submission | null;
};

function compareJudges(a: ResultsJudge, b: ResultsJudge) {
  return a.roster_order - b.roster_order || a.scoring_type.localeCompare(b.scoring_type);
}

/** Gets the frozen roster for one division without returning judge names. */
export function divisionResultsJudges(
  division: string,
  judgeRoster: { competitor_id: string; user_id: string; scoring_type: ScoringType; roster_order: number; expected: boolean }[] = [],
  assignments: { division: string; slot: number; user_id: string; scoring_type?: ScoringType }[] = [],
  competitors: Pick<Competitor, "id" | "division">[] = [],
): ResultsJudge[] {
  const competitorIds = new Set(competitors.filter((row) => row.division === division).map((row) => row.id));
  const frozen = judgeRoster
    .filter((row) => competitorIds.has(row.competitor_id) && row.expected)
    .map((row) => ({ user_id: row.user_id, scoring_type: row.scoring_type, roster_order: row.roster_order }));
  const source = frozen.length ? frozen : assignments
    .filter((row) => row.division === division && (row.scoring_type === "technical" || row.scoring_type === "performance"))
    .map((row) => ({ user_id: row.user_id, scoring_type: row.scoring_type!, roster_order: row.slot }));
  const unique = new Map<string, ResultsJudge>();
  for (const row of source) unique.set(`${row.scoring_type}:${row.user_id}`, row);
  return [...unique.values()].sort(compareJudges);
}

export function scoreForAssignedJudge(ranking: Ranking, judge: ResultsJudge): number | null {
  const ordered = (ranking.judges ?? [])
    .filter((row) => row.scoring_type === judge.scoring_type)
    .sort((a, b) => a.roster_order - b.roster_order);
  const index = ordered.findIndex((row) => row.user_id === judge.user_id);
  if (index < 0) return null;
  return (judge.scoring_type === "technical" ? ranking.technical[index] : ranking.performance[index]) ?? null;
}

function selectedScore(ranking: Ranking, view: ResultsView): number | null {
  if (ranking.dq) return 0;
  if (view === "overall") return ranking.final;
  if (view === "technical") return ranking.raw;
  if (view === "performance") return ranking.average;
  const [, scoringType, userId] = view.split(":") as [string, ScoringType, string];
  const judge = ranking.judges?.find((row) => row.user_id === userId && row.scoring_type === scoringType);
  return judge ? scoreForAssignedJudge(ranking, judge) : null;
}

/** Ranks just one division and the selected aggregate or individual score view. */
export function rankDivisionView(rankings: Ranking[], division: string, view: ResultsView): ResultsRow[] {
  const rows = rankings
    .filter((row) => row.competitor.division === division)
    .map((ranking) => ({ ...ranking, viewScore: selectedScore(ranking, view), viewRank: null as number | null }));
  const rankable = rows.filter((row) => row.dq || row.viewScore !== null)
    .sort((a, b) => Number(a.dq) - Number(b.dq) || (b.viewScore ?? 0) - (a.viewScore ?? 0) || a.competitor.position - b.competitor.position);
  let rank = 0;
  let previousScore: number | null = null;
  let previousDq: boolean | null = null;
  rankable.forEach((row, index) => {
    if (index === 0 || row.dq !== previousDq || row.viewScore !== previousScore) rank = index + 1;
    row.viewRank = rank;
    previousScore = row.viewScore;
    previousDq = row.dq;
  });
  return rows.sort((a, b) => {
    if (a.viewRank !== null && b.viewRank !== null) return a.viewRank - b.viewRank || a.competitor.position - b.competitor.position;
    if (a.viewRank !== null) return -1;
    if (b.viewRank !== null) return 1;
    return a.competitor.position - b.competitor.position;
  });
}

export function resultsViewLabel(view: ResultsView, judges: ResultsJudge[]) {
  if (view === "overall") return "Overall · Weighted Final";
  if (view === "technical") return "Technical · Average raw";
  if (view === "performance") return "Performance · Average raw";
  const [, scoringType, userId] = view.split(":") as [string, ScoringType, string];
  const judge = judges.find((row) => row.user_id === userId && row.scoring_type === scoringType);
  return `${scoringType === "technical" ? "Technical" : "Performance"} · Judge ${judge?.roster_order ?? "—"}`;
}

/** Export data mirrors the visible ranking table and deliberately omits judge identities. */
export function rankingResultsExportRows(rows: ResultsRow[], judges: ResultsJudge[], view: ResultsView, revealPoints: boolean): Record<string, unknown>[] {
  if (!revealPoints) return [];
  return rows.map((row) => ({
    Rank: row.viewRank ?? "Pending",
    Competitor: row.competitor.name,
    View: resultsViewLabel(view, judges),
    "View score": row.viewScore,
    ...Object.fromEntries(judges.map((judge) => [
      `${judge.scoring_type === "technical" ? "Technical" : "Performance"} · Judge ${judge.roster_order}`,
      scoreForAssignedJudge(row, judge),
    ])),
    "Average Technical raw": row.raw,
    "Normalized Technical /70": row.scaled,
    "Average Performance /30": row.average,
    "Weighted Final /100": row.final,
    Status: row.dq ? "DQ" : row.complete ? "Complete" : "Pending",
  }));
}

export function scoreDetailsForCompetitor(
  competitorId: string,
  judges: ResultsJudge[],
  submissions: Submission[],
): ScoreDetailsJudgeRow[] {
  return [...judges].sort(compareJudges).map((judge) => ({
    judge,
    submission: submissions.find((row) => row.competitor_id === competitorId &&
      (row.user_id === judge.user_id || row.historical_user_id === judge.user_id) && row.scoring_type === judge.scoring_type) ?? null,
  }));
}

export function compactTechnicalNotation(event: Event) {
  if (deductions.includes(event.trick)) return `Deduction · ${event.trick}`;
  const [category, dimension] = event.trick.split(" ");
  return `${dimension ?? event.trick}${category ?? ""}L${event.level}${event.execution ?? "E0"}`;
}

/** Emits a row per technical event or Performance category, preserving event order and masking values. */
export function scoreDetailsExportRows(
  competitor: Competitor,
  judgeRows: ScoreDetailsJudgeRow[],
  revealPoints: boolean,
) {
  const rows: Record<string, unknown>[] = [];
  const point = (value: number | null | undefined) => revealPoints ? value ?? "—" : "***";
  for (const { judge, submission } of judgeRows) {
    const base = {
      Competitor: competitor.name,
      Judge: `Judge ${judge.roster_order}`,
      Scoring: judge.scoring_type === "technical" ? "Technical" : "Performance",
      Status: submission ? (submission.finished ? "Submitted" : "Draft") : "Not submitted",
      DQ: submission?.dq ?? false,
      Updated: submission?.updated_at ?? "—",
      Submitted: submission?.submitted_at ?? "—",
    };
    if (!submission) {
      rows.push({ ...base, Event: "—", Details: "—", Value: "—", "Raw total": "—" });
    } else if (judge.scoring_type === "technical") {
      if (!submission.events.length) rows.push({ ...base, Event: "—", Details: "No technical events", Value: "—", "Raw total": point(submission.total) });
      submission.events.forEach((event, index) => rows.push({
        ...base,
        Event: index + 1,
        Details: deductions.includes(event.trick)
          ? `Deduction · ${event.trick}`
          : `${event.trick} · L${event.level} · ${event.features.join(" + ") || "No features"} · ${executionLabels[event.execution ?? "E0"]} · ${compactTechnicalNotation(event)}`,
        Category: deductions.includes(event.trick) ? "Deduction" : event.trick.split(" ")[0],
        Level: deductions.includes(event.trick) ? "—" : event.level,
        Features: deductions.includes(event.trick) ? "—" : event.features.join(" + ") || "No features",
        Execution: deductions.includes(event.trick) ? "—" : executionLabels[event.execution ?? "E0"],
        Timestamp: event.at,
        Value: point(event.value),
        "Raw total": point(submission.total),
      }));
    } else {
      categories.forEach((category, index) => rows.push({
        ...base,
        Event: index + 1,
        Category: category,
        Value: point(submission.performance[index]),
        "Raw total": point(submission.total),
      }));
    }
  }
  return rows;
}
