import { categories, deductions, type Competitor, type Event, type Ranking, type Submission } from "./model";

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
  const rounded = (value: number | null) => value == null ? null : Number(value.toFixed(2));
  return rows.map((row) => ({
    Rank: row.viewRank ?? "Pending",
    Competitor: row.competitor.name,
    View: resultsViewLabel(view, judges),
    "View score": rounded(row.viewScore),
    ...Object.fromEntries(judges.map((judge) => [
      `${judge.scoring_type === "technical" ? "Technical" : "Performance"} · Judge ${judge.roster_order}`,
      rounded(scoreForAssignedJudge(row, judge)),
    ])),
    "Average Technical raw": rounded(row.raw),
    "Normalized Technical /70": rounded(row.scaled),
    "Average Performance /30": rounded(row.average),
    "Weighted Final /100": rounded(row.final),
    Status: row.dq ? "DQ" : row.complete ? "Complete" : "Pending",
  }));
}

/** Readable pipe table for the TXT rankings export; calculations remain untouched. */
export function rankingResultsExportText(rows: ResultsRow[], judges: ResultsJudge[], view: ResultsView, revealPoints: boolean) {
  const records = rankingResultsExportRows(rows, judges, view, revealPoints);
  if (!records.length) return "";

  const headers = Object.keys(records[0]);
  const textCell = (value: unknown) => {
    if (value == null) return "Pending";
    if (typeof value === "number" && Number.isFinite(value)) return String(Number(value.toFixed(2)));
    return String(value).replaceAll("|", "/").replace(/[\r\n]+/g, " ");
  };
  const tableRows = [
    headers,
    ...records.map((record) => headers.map((header) => textCell(record[header]))),
  ];
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...tableRows.slice(1).map((row) => row[index].length),
  ));
  const render = (row: string[]) => row.map((cell, index) => ` ${cell.padEnd(widths[index])} `).join("|");
  const rule = widths.map((width) => "-".repeat(width + 2)).join("+");

  return [render(tableRows[0]), rule, ...tableRows.slice(1).map(render)].join("\r\n");
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

export type ScoreDetailsExportSection = {
  competitor: Competitor;
  judgeRows: ScoreDetailsJudgeRow[];
};

/** Builds consistent CSV-style sections for one or many competitors and judges. */
export function scoreDetailsExportContent(
  sections: ScoreDetailsExportSection[],
  revealPoints: boolean,
  format: "csv" | "txt" = "csv",
) {
  const lines: string[] = [];
  const separator = format === "txt" ? "--------------------------------------------------" : "==================================================";
  const cell = (value: unknown) => {
    const numeric = typeof value === "number" && Number.isFinite(value);
    let text = value == null ? "" : String(value);
    if (!numeric && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  };
  const row = (values: unknown[]) => values.map(cell).join(",");
  const pipeRow = (values: unknown[]) => values.map((value) => String(value ?? "").replaceAll("|", "/").replace(/[\r\n]+/g, " ")).join(" | ");
  const point = (value: number | null | undefined) => revealPoints
    ? value == null ? "" : Number(value.toFixed(2))
    : "***";
  const submittedAt = (value?: string | null) => {
    if (!value) return "";
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  };

  sections.forEach(({ competitor, judgeRows }, sectionIndex) => {
    if (sectionIndex > 0 && lines.at(-1) !== separator) lines.push(separator);
    judgeRows.forEach(({ judge, submission }) => {
      const scoringLabel = judge.scoring_type === "technical" ? "Technical" : "Performance";
      const metadataRow = (label: string, value: string) => lines.push(
        format === "txt" ? pipeRow([label, value]) : row([`${label}: ${value}`]),
      );
      metadataRow("Competitor", competitor.name);
      metadataRow("Judge", `Judge ${judge.roster_order}`);
      metadataRow("Judge Category", scoringLabel);
      metadataRow("Submitted At", submittedAt(submission?.submitted_at));

      if (judge.scoring_type === "technical") {
        lines.push("TECHNICAL SCORES");
        const events = submission?.events ?? [];
        if (format === "txt") lines.push(pipeRow(["#", "Trick / deduction", "Final"]));
        events.forEach((event, index) => {
          const isDeduction = deductions.includes(event.trick);
          const [trickType, difficulty] = event.trick.split(" ");
          const label = isDeduction
            ? event.trick
            : `${trickType}${difficulty ?? ""}L${event.level}${event.execution ?? "E0"}` +
              `${event.features.length ? ` [${event.features.join(" + ")}]` : ""}`;
          lines.push(format === "txt"
            ? pipeRow([index + 1, label, point(event.value)])
            : row([index + 1, ` ${label}: ${point(event.value)}`]));
        });
        const calculatedTotal = submission?.total ?? submission?.events.reduce((sum, event) => sum + (event.value ?? 0), 0);
        lines.push(format === "txt"
          ? pipeRow(["Technical Total", submission ? point(calculatedTotal) : "Not submitted"])
          : `Technical Total: ${submission ? point(calculatedTotal) : "Not submitted"}`);
      } else {
        lines.push("PERFORMANCE SCORES");
        if (format === "txt") lines.push(pipeRow(["Category", "Score"]));
        categories.forEach((category, index) => lines.push(
          format === "txt"
            ? pipeRow([category, submission ? point(submission.performance[index]) : ""])
            : `${category}: ${submission ? point(submission.performance[index]) : ""}`,
        ));
        const calculatedTotal = submission?.total ?? submission?.performance.reduce((sum, value) => sum + value, 0);
        lines.push(format === "txt"
          ? pipeRow(["Performance Total", submission ? point(calculatedTotal) : "Not submitted"])
          : `Performance Total: ${submission ? point(calculatedTotal) : "Not submitted"}`);
      }
      lines.push(separator);
    });
  });
  return lines.join("\r\n");
}
