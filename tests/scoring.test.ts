import { test } from "node:test";
import assert from "node:assert/strict";
import { eventScore, rankGlobal, total } from "../lib/scoring";
import {
  calculateScoringConfigurationImpact,
  DEFAULT_SCORING_RULES,
  validateScoringRules,
} from "../lib/scoring-config";
import { executionOptions } from "../lib/model";
import { matchHotkeyAction, stepTechnicalLevel, technicalLevels } from "../lib/technical-controls";
import { applyLocal } from "../lib/local";
import { Competitor, Event, Submission, Snapshot } from "../lib/model";
const event = (trick: string, level = 1, features: string[] = [], execution?: Event["execution"]): Event => ({
  id: crypto.randomUUID(),
  trick,
  level,
  features,
  ...(execution ? { execution } : {}),
  at: new Date().toISOString(),
});
const competitor = (id: string, division = "Individual Open"): Competitor => ({
  id,
  name: id,
  division,
  position: Number(id) || 1,
  status: "locked",
  dq: false,
  archived: false,
});
const submission = (id: string, slot: number, scoring_type: "technical" | "performance" = "technical"): Submission => ({
  id: crypto.randomUUID(),
  user_id: `judge${slot}`,
  competitor_id: id,
  slot,
  scoring_type,
  events: [event("T 3D")],
  performance: [5, 5, 5, 5, 5, 5],
  finished: true,
  dq: false,
  version: 1,
  updated_at: new Date().toISOString(),
});
test("technical bases and compounded features, without extra multipliers", () => {
  assert.equal(eventScore(event("# 2D"), DEFAULT_SCORING_RULES), 0.7);
  assert.equal(eventScore(event("T 3D", 2, ["T1", "T2"]), DEFAULT_SCORING_RULES), 61.199999999999996);
  assert.equal(eventScore(event("W VD", 0.5), DEFAULT_SCORING_RULES), 0.2);
  assert.equal(eventScore(event("Unintentional Drop", 10, ["T3"]), DEFAULT_SCORING_RULES), -0.3);
  assert.equal(eventScore(event("Other Rule Violation"), DEFAULT_SCORING_RULES), -2);
});
test("execution choices multiply completed trick scores and never alter fixed deductions", () => {
  const base = event("T 2D", 2);
  assert.equal(eventScore({ ...base, execution: "E0" }, DEFAULT_SCORING_RULES), 2);
  assert.equal(eventScore({ ...base, execution: "E-1" }, DEFAULT_SCORING_RULES), 1.8);
  assert.equal(eventScore({ ...base, execution: "E-2" }, DEFAULT_SCORING_RULES), 1.6);
  assert.equal(eventScore({ ...base, execution: "E-3" }, DEFAULT_SCORING_RULES), 1.4);
  assert.equal(eventScore(event("T 2D", 2, ["T1"], "E-3"), DEFAULT_SCORING_RULES), 2 * 1.7 * 0.7);
  assert.equal(eventScore(event("Unintentional Drop", 10, ["T3"], "E-3"), DEFAULT_SCORING_RULES), -0.3);
  assert.equal(eventScore(event("T 2D", 2), DEFAULT_SCORING_RULES), 2, "legacy events without execution remain normal E0");
  assert.deepEqual(executionOptions, ["E0", "E-1", "E-2", "E-3"], "no positive execution option is available");
  const legacyRules = structuredClone(DEFAULT_SCORING_RULES) as any;
  delete legacyRules.executions;
  assert.deepEqual(validateScoringRules(legacyRules).executions, DEFAULT_SCORING_RULES.executions);
  assert.throws(() => validateScoringRules({ ...DEFAULT_SCORING_RULES, executions: { ...DEFAULT_SCORING_RULES.executions, "E+1": 1.1 } }));
});
test("level step controls follow direct-button order and clamp at L0.5 and L10", () => {
  assert.deepEqual(technicalLevels.map((level) => stepTechnicalLevel(level, 1)), [...technicalLevels.slice(1), 10]);
  assert.deepEqual(technicalLevels.map((level) => stepTechnicalLevel(level, -1)), [0.5, ...technicalLevels.slice(0, -1)]);
  assert.equal(stepTechnicalLevel(0.5, -1), 0.5);
  assert.equal(stepTechnicalLevel(10, 1), 10);
});
test("level and execution actions resolve through user-configured hotkeys", () => {
  const hotkeys = {
    "level:next": "u",
    "level:previous": "j",
    "level:2": "q",
    "execution:E0": "n0",
    "execution:E-1": "n1",
    "execution:E-2": "n2",
    "execution:E-3": "n3",
  };
  assert.equal(matchHotkeyAction(hotkeys, "u", "u"), "level:next");
  assert.equal(matchHotkeyAction(hotkeys, "j", "j"), "level:previous");
  assert.equal(matchHotkeyAction(hotkeys, "q", "q"), "level:2", "direct level shortcuts remain available");
  assert.equal(matchHotkeyAction(hotkeys, "n2", "2"), "execution:E-2");
  assert.equal(matchHotkeyAction(hotkeys, "n3", "3"), "execution:E-3");
});
test("division normalization, complete scores, missing scores, and DQ", () => {
  const comps = [
    competitor("1"),
    competitor("2"),
    competitor("3", "Individual Juniors"),
    competitor("4"),
    competitor("5", "Exhibition"),
  ];
  comps[3].dq = true;
  const groups = ["technical", "technical", "technical", "performance", "performance"] as const;
  const subs = groups.flatMap((scoringType, index) => {
    const slot = index + 1;
    return [
      submission("1", slot, scoringType),
      submission("2", slot, scoringType),
      submission("3", slot, scoringType),
      submission("4", slot, scoringType),
    ];
  });
  subs.find((s) => s.competitor_id === "2" && s.slot === 5)!.finished = false;
  const results = rankGlobal(comps, subs, DEFAULT_SCORING_RULES);
  assert.equal(results.find((r) => r.competitor.id === "1")!.final, 100);
  assert.equal(results.find((r) => r.competitor.id === "2")!.final, null);
  assert.equal(results.find((r) => r.competitor.id === "3")!.final, 100);
  assert.equal(results.find((r) => r.competitor.id === "4")!.final, 0);
  assert.equal(results.length, 4);
});
test("variable judge groups average within Technical and Performance before 70/30 ranking", () => {
  const competitors = [competitor("1"), competitor("2")];
  const assignments = [
    { division: "Individual Open", slot: 1, user_id: "tech-a", scoring_type: "technical" as const },
    { division: "Individual Open", slot: 2, user_id: "tech-b", scoring_type: "technical" as const },
    { division: "Individual Open", slot: 3, user_id: "perf-a", scoring_type: "performance" as const },
  ];
  const rows = [
    { competitor_id: "1", user_id: "tech-a", slot: 1, scoring_type: "technical" as const, level: 1 },
    { competitor_id: "1", user_id: "tech-b", slot: 1, scoring_type: "technical" as const, level: 2 },
    { competitor_id: "1", user_id: "perf-a", slot: 4, scoring_type: "performance" as const, level: 1 },
    { competitor_id: "2", user_id: "tech-a", slot: 1, scoring_type: "technical" as const, level: 3 },
    { competitor_id: "2", user_id: "tech-b", slot: 1, scoring_type: "technical" as const, level: 4 },
    { competitor_id: "2", user_id: "perf-a", slot: 4, scoring_type: "performance" as const, level: 2 },
  ].map((row) => {
    const saved = submission(row.competitor_id, row.slot);
    saved.user_id = row.user_id;
    saved.scoring_type = row.scoring_type;
    saved.events = row.scoring_type === "technical" ? [event("T 3D", row.level)] : [];
    saved.performance = row.scoring_type === "performance" ? Array(6).fill(row.level === 1 ? 3 : 2) : [];
    return saved;
  });
  const results = rankGlobal(competitors, rows, DEFAULT_SCORING_RULES, assignments);
  const first = results.find((result) => result.competitor.id === "1")!;
  const second = results.find((result) => result.competitor.id === "2")!;
  assert.equal(first.complete, true);
  assert.equal(first.technical.length, 2);
  assert.equal(first.performance.length, 1);
  assert.equal(first.raw, 9);
  assert.equal(first.average, 18);
  assert.equal(first.final, 48);
  assert.equal(second.raw, 21);
  assert.equal(second.average, 12);
  assert.equal(second.final, 82);
  rows.find((row) => row.competitor_id === "1" && row.user_id === "perf-a")!.finished = false;
  assert.equal(rankGlobal(competitors, rows, DEFAULT_SCORING_RULES, assignments).find((result) => result.competitor.id === "1")!.complete, false);
});
test("zero and negative raw values cannot create NaN or negative final scores", () => {
  const groups = ["technical", "technical", "technical", "performance", "performance"] as const;
  const subs = groups.map((scoringType, index) => submission("1", index + 1, scoringType));
  subs.forEach((s) => { if (s.scoring_type === "technical") s.events = [event("Time Violation")]; });
  const r = rankGlobal([competitor("1")], subs, DEFAULT_SCORING_RULES)[0];
  assert.equal(r.scaled, 0);
  assert.equal(r.final, 30);
});
test("editing a base value recalculates saved events, totals, and completed rankings from their unchanged selections", () => {
  const rules = structuredClone(DEFAULT_SCORING_RULES);
  const changedRules = structuredClone(rules);
  changedRules.bases.T["1D"] = 3;
  const originalEvent = event("T 1D");
  const first = submission("1", 1);
  first.events = [originalEvent];
  const second = submission("2", 1);
  second.events = [event("T 2D")];
  const competitors = [competitor("1"), competitor("2")];
  const groups = ["technical", "technical", "technical", "performance", "performance"] as const;
  const submissions = groups.flatMap((scoringType, index) => {
    const slot = index + 1;
    const a = submission("1", slot, scoringType);
    a.events = scoringType === "technical" ? [event("T 1D")] : [];
    if (scoringType === "performance") a.performance = [5, 5, 5, 5, 5, 5];
    const b = submission("2", slot, scoringType);
    b.events = scoringType === "technical" ? [event("T 2D")] : [];
    if (scoringType === "performance") b.performance = [5, 5, 5, 5, 5, 5];
    return [a, b];
  });
  const savedSelections = structuredClone(submissions.map((saved) => saved.events));
  assert.equal(eventScore(originalEvent, rules), 0.1);
  assert.equal(total(first, rules), 0.1);
  assert.equal(total(first, changedRules), 3);
  const before = rankGlobal(competitors, submissions, rules);
  const after = rankGlobal(competitors, submissions, changedRules);
  assert.equal(before[0].competitor.id, "2");
  assert.equal(after[0].competitor.id, "1");
  assert.equal(total(submissions[0], changedRules), 3);
  assert.deepEqual(submissions.map((saved) => saved.events), savedSelections);
});
test("changing execution configuration recalculates historical event values, totals, rankings, and impact", () => {
  const oldRules = structuredClone(DEFAULT_SCORING_RULES);
  const newRules = structuredClone(oldRules);
  newRules.executions["E-2"] = 0.5;
  const competitorOne = competitor("1");
  const competitorTwo = competitor("2");
  const groups = ["technical", "technical", "technical", "performance", "performance"] as const;
  const submissions = groups.flatMap((scoringType, index) => [competitorOne, competitorTwo].map((target, competitorIndex) => {
    const slot = index + 1;
    const saved = submission(target.id, slot, scoringType);
    saved.events = scoringType === "technical" ? [event("T 2D", 2, [], "E-2")] : [];
    if (scoringType === "performance") saved.performance = [5, 5, 5, 5, 5, 5];
    if (competitorIndex === 1 && scoringType === "technical") saved.events = [event("T 2D", 2, [], "E0")];
    return saved;
  }));
  const beforeEvents = structuredClone(submissions.map((saved) => saved.events));
  assert.equal(eventScore(submissions[0].events[0], oldRules), 1.6);
  assert.equal(eventScore(submissions[0].events[0], newRules), 1);
  const beforeRankings = rankGlobal([competitorOne, competitorTwo], submissions, oldRules);
  const afterRankings = rankGlobal([competitorOne, competitorTwo], submissions, newRules);
  assert.notEqual(beforeRankings.find((row) => row.competitor.id === "1")?.final, afterRankings.find((row) => row.competitor.id === "1")?.final);
  assert.deepEqual(submissions.map((saved) => saved.events), beforeEvents, "recalculation preserves event choices and timestamps");
  assert.deepEqual(calculateScoringConfigurationImpact(oldRules, newRules, submissions, [competitorOne, competitorTwo]), {
    technicalSubmissions: 3,
    technicalEventValues: 3,
    competitors: 2,
    rankingDivisions: 1,
    finalizedRankings: 2,
  });
});
test("impact summary includes affected submissions and every finalized ranking in the division", () => {
  const rules = structuredClone(DEFAULT_SCORING_RULES);
  const nextRules = structuredClone(rules);
  nextRules.bases.T["1D"] = 3;
  const competitors = [competitor("1"), competitor("2")];
  const groups = ["technical", "technical", "technical", "performance", "performance"] as const;
  const submissions = groups.flatMap((scoringType, index) => ["1", "2"].map((id) => {
    const saved = submission(id, index + 1, scoringType);
    saved.events = scoringType === "technical" ? [event(id === "1" ? "T 1D" : "T 2D")] : [];
    return saved;
  }));
  const impact = calculateScoringConfigurationImpact(rules, nextRules, submissions, competitors);
  assert.deepEqual(impact, {
    technicalSubmissions: 3,
    technicalEventValues: 3,
    competitors: 2,
    rankingDivisions: 1,
    finalizedRankings: 2,
  });
});

test("configuration impact keeps deleted judges' submitted scores in the locked roster completion count", () => {
  const oldRules = structuredClone(DEFAULT_SCORING_RULES);
  const newRules = structuredClone(oldRules);
  newRules.bases.T["1D"] = 2;
  const competitor: Competitor = {
    id: "preserved-competitor", name: "Preserved", division: "Open", position: 1,
    status: "locked", dq: false, archived: false,
  };
  const submissions: Submission[] = [
    { id: "tech-score", competitor_id: competitor.id, user_id: "judge-tech", historical_user_id: "judge-tech", slot: 1, scoring_type: "technical", events: [{ id: "event", trick: "T 1D", level: 1, features: [], at: "2026-09-01T12:00:00.000Z" }], performance: [], finished: true, dq: false, version: 1, updated_at: "2026-09-01T12:00:00.000Z" },
    { id: "former-performance", competitor_id: competitor.id, user_id: null, historical_user_id: "deleted-perf", judge_name_snapshot: "Riley Shah", judge_role_snapshot: "performance_judge", slot: 2, scoring_type: "performance", events: [], performance: [4, 4, 4, 4, 4, 4], finished: true, dq: false, version: 1, updated_at: "2026-09-01T12:00:00.000Z" },
  ];
  const impact = calculateScoringConfigurationImpact(oldRules, newRules, submissions, [competitor],
    [{ division: "Open", slot: 1, user_id: "judge-tech", scoring_type: "technical" }],
    [
      { competitor_id: competitor.id, user_id: "judge-tech", scoring_type: "technical", expected: true },
      { competitor_id: competitor.id, user_id: "deleted-perf", scoring_type: "performance", expected: true },
      { competitor_id: competitor.id, user_id: "no-longer-expected", scoring_type: "technical", expected: false },
    ],
  );
  assert.deepEqual(impact, {
    technicalSubmissions: 1, technicalEventValues: 1, competitors: 1,
    rankingDivisions: 1, finalizedRankings: 1,
  });
});
test("local edit preserves order and delete is reversible in history operations", () => {
  const first = event("T 1D"),
    second = event("O 2D");
  const sub = submission("1", 1);
  sub.events = [first, second];
  const snapshot: Snapshot = {
    profile: {
      id: "judge1",
      name: "Judge",
      slot: 1,
      role: "judge",
      active: true,
    },
    competitors: [competitor("1")],
    submissions: [sub],
    protected: false,
  };
  const next = applyLocal(snapshot, {
    id: crypto.randomUUID(),
    competitor_id: "1",
    expected_version: 1,
    kind: "put_event",
    payload: { ...first, level: 3 },
  });
  assert.equal(next.submissions[0].events.length, 2);
  assert.equal(next.submissions[0].events[0].level, 3);
  assert.equal(snapshot.submissions[0].events[0].level, 1);
  assert.equal(next.submissions[0].version, 2);
});
