import { test } from "node:test";
import assert from "node:assert/strict";
import type { Competitor, Event, Ranking, ScoringRules, Submission } from "../lib/model";
import {
  compactTechnicalNotation,
  divisionResultsJudges,
  rankDivisionView,
  rankingResultsExportRows,
  scoreDetailsExportContent,
  scoreDetailsForCompetitor,
  scoreForAssignedJudge,
  type ResultsJudge,
} from "../lib/results";

const competitor = (id: string, division = "Open", position = Number(id) || 1): Competitor => ({
  id, name: `Competitor ${id}`, division, position, status: "locked", dq: false, archived: false,
});

const ranking = (
  id: string,
  division: string,
  position: number,
  scores: { technical: number[]; performance: number[]; raw: number | null; scaled: number | null; average: number | null; final: number | null; dq?: boolean; complete?: boolean },
  judges: Ranking["judges"],
): Ranking => ({
  competitor: { ...competitor(id, division, position), dq: !!scores.dq },
  judges,
  technical: scores.technical,
  performance: scores.performance,
  raw: scores.raw,
  scaled: scores.scaled,
  average: scores.average,
  final: scores.dq ? 0 : scores.final,
  complete: scores.complete ?? true,
  dq: !!scores.dq,
  rank: null,
});

test("division judge columns use each frozen roster and adapt to different judge counts", () => {
  const competitors = [competitor("1", "Two Judge"), competitor("2", "Ten Judge")];
  const roster = [
    { competitor_id: "1", user_id: "t1", scoring_type: "technical" as const, roster_order: 1, expected: true },
    { competitor_id: "1", user_id: "p2", scoring_type: "performance" as const, roster_order: 2, expected: true },
    ...Array.from({ length: 10 }, (_, index) => ({
      competitor_id: "2",
      user_id: `judge-${index + 1}`,
      scoring_type: (index < 8 ? "technical" : "performance") as "technical" | "performance",
      roster_order: index + 1,
      expected: true,
      display_name: `Private Name ${index + 1}`,
    })),
  ];
  const two = divisionResultsJudges("Two Judge", roster, [], competitors);
  const ten = divisionResultsJudges("Ten Judge", roster, [], competitors);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((row) => row.roster_order), [1, 2]);
  assert.equal(ten.length, 10);
  assert.equal(ten.filter((row) => row.scoring_type === "technical").length, 8);
  assert.equal(ten.filter((row) => row.scoring_type === "performance").length, 2);
  assert.doesNotMatch(JSON.stringify([...two, ...ten]), /Private Name/);
});

test("ranking views sort within a division and use skipped competition ranks for ties", () => {
  const judges: NonNullable<Ranking["judges"]> = [
    { user_id: "tech-1", scoring_type: "technical", roster_order: 1, display_name: "Hidden Tech One" },
    { user_id: "perf-2", scoring_type: "performance", roster_order: 2, display_name: "Hidden Perf Two" },
    { user_id: "tech-3", scoring_type: "technical", roster_order: 3, display_name: "Hidden Tech Three" },
  ];
  const rows = [
    ranking("1", "Open", 1, { technical: [20, 40], performance: [20], raw: 30, scaled: 60, average: 20, final: 80 }, judges),
    ranking("2", "Open", 2, { technical: [30, 30], performance: [20], raw: 30, scaled: 60, average: 20, final: 80 }, judges),
    ranking("3", "Open", 3, { technical: [10, 20], performance: [19], raw: 15, scaled: 30, average: 19, final: 49 }, judges),
    ranking("4", "Open", 4, { technical: [90, 90], performance: [30], raw: 90, scaled: 0, average: 0, final: null, dq: true }, judges),
    ranking("5", "Open", 5, { technical: [null as unknown as number, 40], performance: [null as unknown as number], raw: null, scaled: null, average: null, final: null, complete: false }, judges),
    ranking("6", "Juniors", 1, { technical: [100, 100], performance: [30], raw: 100, scaled: 70, average: 30, final: 100 }, judges),
  ];

  const overall = rankDivisionView(rows, "Open", "overall");
  assert.equal(overall.length, 5, "other divisions are excluded");
  assert.deepEqual(overall.slice(0, 3).map((row) => row.competitor.id), ["1", "2", "3"]);
  assert.deepEqual(overall.slice(0, 3).map((row) => row.viewRank), [1, 1, 3]);
  assert.equal(overall[3].competitor.id, "4", "DQ rows sort after non-DQ results");
  assert.equal(overall[3].viewScore, 0);
  assert.equal(overall[4].viewRank, null, "incomplete rows remain pending");

  const technical = rankDivisionView(rows, "Open", "technical");
  assert.equal(technical.at(-2)?.competitor.id, "4", "DQ stays behind scored non-DQ rows even with a high raw score");
  assert.equal(technical.at(-2)?.viewScore, 0);
  assert.equal(technical.find((row) => row.competitor.id === "1")?.viewScore, 30);
  const performance = rankDivisionView(rows, "Open", "performance");
  assert.equal(performance[0].viewScore, 20, "performance scores are ranked directly, without normalization");
  const individual = rankDivisionView(rows, "Open", "judge:technical:tech-1");
  assert.equal(individual[0].competitor.id, "2");
  assert.equal(individual[0].viewScore, 30);
  assert.equal(scoreForAssignedJudge(rows[0], { user_id: "tech-3", scoring_type: "technical", roster_order: 3 }), 40);
});

test("ranking exports follow the selected division/view and never include judge names", () => {
  const judges: NonNullable<Ranking["judges"]> = [
    { user_id: "tech-1", scoring_type: "technical", roster_order: 1, display_name: "Secret Technical Name" },
    { user_id: "perf-2", scoring_type: "performance", roster_order: 2, display_name: "Secret Performance Name" },
  ];
  const source = ranking("1", "Open", 1, { technical: [12], performance: [18], raw: 12, scaled: 70, average: 18, final: 88 }, judges);
  const visible = rankDivisionView([source], "Open", "performance");
  const roster: ResultsJudge[] = [
    { user_id: "tech-1", scoring_type: "technical", roster_order: 1 },
    { user_id: "perf-2", scoring_type: "performance", roster_order: 2 },
  ];
  const exported = rankingResultsExportRows(visible, roster, "performance", true);
  assert.equal(exported[0].Rank, 1);
  assert.equal(exported[0].View, "Performance · Average raw");
  assert.equal(exported[0]["Technical · Judge 1"], 12);
  assert.equal(exported[0]["Performance · Judge 2"], 18);
  assert.equal(exported[0]["Average Technical raw"], 12);
  assert.equal(exported[0]["Normalized Technical /70"], 70);
  assert.equal(exported[0]["Average Performance /30"], 18);
  assert.equal(exported[0]["Weighted Final /100"], 88);
  assert.doesNotMatch(JSON.stringify(exported), /Secret .* Name|tech-1|perf-2/);
  assert.deepEqual(rankingResultsExportRows(visible, roster, "performance", false), []);
});

test("compact technical notation keeps category codes out of feature metadata and marks deductions", () => {
  const shuffle: Event = { id: "shuffle", trick: "# 3D", level: 2, features: [], execution: "E-2", at: "2026-11-01T12:00:00Z", value: 12345 };
  const trick: Event = { id: "trick", trick: "T 2D", level: 4, features: ["T1", "T2"], execution: "E0", at: "2026-11-01T12:01:00Z" };
  const deduction: Event = { id: "deduction", trick: "Tangle", level: 1, features: [], at: "2026-11-01T12:02:00Z" };
  assert.equal(compactTechnicalNotation(shuffle), "3D#L2E-2");
  assert.equal(compactTechnicalNotation(trick), "2DTL4E0");
  assert.equal(compactTechnicalNotation(deduction), "Deduction · Tangle");
});

test("competitor details keep every assigned judge together and preserve event/category order in exports", () => {
  const target = competitor("1", "Open", 7);
  const judges: ResultsJudge[] = [
    { user_id: "technical-1", scoring_type: "technical", roster_order: 1 },
    { user_id: "performance-2", scoring_type: "performance", roster_order: 2 },
    { user_id: "deleted-technical-3", scoring_type: "technical", roster_order: 3 },
  ];
  const technical: Submission = {
    id: "tech-submission", competitor_id: target.id, user_id: "technical-1", slot: 1,
    scoring_type: "technical", events: [
      { id: "event-1", trick: "# 3D", level: 2, features: [], execution: "E-2", at: "2026-11-01T12:00:00Z", value: 12.34 },
      { id: "event-2", trick: "Unintentional Drop", level: 1, features: [], at: "2026-11-01T12:01:00Z", value: -0.3 },
      { id: "event-3", trick: "T 2D", level: 4, features: ["T1", "A"], execution: "E0", at: "2026-11-01T12:02:00Z", value: 56.78 },
    ], performance: [], total: 68.82, finished: true, dq: false, version: 3,
    updated_at: "2026-11-01T12:03:00Z", submitted_at: "2026-11-01T12:03:00Z",
  };
  const performance: Submission = {
    id: "perf-submission", competitor_id: target.id, user_id: null, historical_user_id: "performance-2",
    judge_name_snapshot: "Historical Name Must Not Export", judge_role_snapshot: "performance_judge", slot: 2,
    scoring_type: "performance", events: [], performance: [1, 2, 3, 4, 5, 6], total: 21,
    finished: true, dq: false, version: 2, updated_at: "2026-11-01T12:04:00Z", submitted_at: "2026-11-01T12:04:00Z",
  };
  const grouped = scoreDetailsForCompetitor(target.id, judges, [technical, performance]);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped.map((row) => row.judge.roster_order), [1, 2, 3]);
  assert.equal(grouped[1].submission?.id, performance.id, "historical attribution matches deleted profiles");
  assert.equal(grouped[2].submission, null, "unsubmitted assigned judges still appear");

  const rules: ScoringRules = {
    bases: { "#": { "3D": 10 }, T: { "2D": 20 } },
    deductions: { "Unintentional Drop": -0.3 },
    levels: { "1": 1, "2": 2, "4": 4 },
    features: { T1: 1.2, A: 1.7 },
    executions: { E0: 1, "E-1": 0.9, "E-2": 0.8, "E-3": 0.7 },
  };
  const exported = scoreDetailsExportContent([{ competitor: target, judgeRows: grouped }], true, rules);
  const lines = exported.split("\r\n");
  assert.equal(lines[0], "Competitor,Competitor 1");
  assert.equal(lines[1], "Judge,Judge 1");
  assert.equal(lines[2], "Judge Category,Technical");
  assert.equal(lines[3], "Submitted At,2026-11-01T12:03:00.000Z");
  assert.ok(lines.includes("#,Identifier,Trick,Difficulty,Base,Features,Execution,Level,Final"));
  assert.ok(lines.includes("1,3D#L2E-2,#,3D,10,—,E-2,L2,12.34"));
  assert.ok(lines.includes("2,Deduction · Unintentional Drop,Unintentional Drop,—,-0.3,—,—,—,-0.3"));
  assert.ok(lines.includes('3,2DTL4E0,T,2D,20,"T1, A",E0,L4,56.78'), "comma-containing feature values are quoted as one CSV field");
  assert.ok(lines.includes("Technical Total,,,,,,,,68.82"));
  assert.ok(lines.includes("Judge,Judge 2"));
  assert.ok(lines.includes("Judge Category,Performance"));
  assert.ok(lines.includes("Category,Score"));
  assert.ok(lines.includes("Control,1"));
  assert.ok(lines.includes("Showmanship,6"));
  assert.ok(lines.includes("Performance Total,21"));
  assert.ok(lines.includes("Judge,Judge 3"));
  assert.ok(lines.includes("Technical Total,,,,,,,,—"));
  assert.doesNotMatch(exported, /Historical Name Must Not Export|technical-1|performance-2|deleted-technical-3/);
  assert.doesNotMatch(exported, /2026-11-01T12:00:00Z|2026-11-01T12:01:00Z|2026-11-01T12:02:00Z/, "event timestamps are not exported");
  assert.doesNotMatch(exported, /Normalized|Weighted Final/);

  const masked = scoreDetailsExportContent([{ competitor: target, judgeRows: grouped }], false, rules);
  assert.ok(masked.includes("1,3D#L2E-2,#,3D,***,—,E-2,L2,***"));
  assert.ok(masked.includes("Control,***"));
  assert.ok(masked.includes("Technical Total,,,,,,,,***"));
  assert.doesNotMatch(masked, /12\.34|68\.82|56\.78|Historical Name Must Not Export/);

  const second = competitor("2", "Open", 8);
  const multi = scoreDetailsExportContent([
    { competitor: target, judgeRows: grouped.slice(0, 1) },
    { competitor: second, judgeRows: scoreDetailsForCompetitor(second.id, judges.slice(1, 2), []) },
  ], true, rules);
  assert.equal(multi.split("Competitor,").length - 1, 2, "each competitor starts a complete section");
  assert.equal(multi.split("==================================================").length - 1, 2, "competitor sections have a clear separator");
  assert.ok(multi.includes("Competitor,Competitor 2"));

  const commaName = scoreDetailsExportContent([
    { competitor: { ...target, name: "Lo, Graham" }, judgeRows: grouped.slice(0, 1) },
  ], true, rules);
  assert.ok(commaName.startsWith('Competitor,"Lo, Graham"'), "competitor names with commas stay in one field");
});
