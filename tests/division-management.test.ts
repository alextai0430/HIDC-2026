import { test } from "node:test";
import assert from "node:assert/strict";
import type { Competitor, Profile, Submission } from "../lib/model";
import {
  competitorProgress,
  divisionCompetitors,
  divisionJudgeRoster,
  divisionRosterIsValid,
  type DivisionAssignment,
} from "../lib/division-management";

const competitor = (id: string, division: string, position: number, status: Competitor["status"] = "upcoming"): Competitor => ({
  id, name: id, division, position, status, dq: false, archived: false,
});

const profiles: Profile[] = [
  { id: "t1", username: "tech1", name: "Taylor Chen", role: "technical_judge", active: true },
  { id: "t2", username: "tech2", name: "Morgan Lee", role: "technical_judge", active: true },
  { id: "p1", username: "perf1", name: "Riley Shah", role: "performance_judge", active: true },
];

const assignments: DivisionAssignment[] = [
  { division: "Teams", slot: 1, user_id: "t1", scoring_type: "technical" },
  { division: "Teams", slot: 2, user_id: "t2", scoring_type: "technical" },
  { division: "Teams", slot: 3, user_id: "p1", scoring_type: "performance" },
  { division: "Solo", slot: 1, user_id: "t1", scoring_type: "technical" },
  { division: "Solo", slot: 2, user_id: "p1", scoring_type: "performance" },
];

const submission = (id: string, competitorId: string, userId: string, scoringType: "technical" | "performance", finished: boolean): Submission => ({
  id, competitor_id: competitorId, user_id: userId, slot: 1, scoring_type: scoringType,
  events: [], performance: [0, 0, 0, 0, 0, 0], finished, dq: false, version: 1, updated_at: "now",
});

test("division rosters require 2–10 unique consecutive numbers with both scoring groups", () => {
  const roster = [{ slot: 1, scoring_type: "technical" as const }, { slot: 2, scoring_type: "performance" as const }];
  assert.equal(divisionRosterIsValid(roster), true);
  assert.equal(divisionRosterIsValid([{ slot: 1, scoring_type: "technical" }]), false);
  assert.equal(divisionRosterIsValid(Array.from({ length: 11 }, (_, i) => ({ slot: i + 1, scoring_type: i === 10 ? "performance" as const : "technical" as const }))), false);
  assert.equal(divisionRosterIsValid([{ slot: 1, scoring_type: "technical" }, { slot: 3, scoring_type: "performance" }]), false);
  assert.equal(divisionRosterIsValid([{ slot: 1, scoring_type: "technical" }, { slot: 2, scoring_type: "technical" }]), false);
  assert.equal(divisionRosterIsValid([{ slot: 1, scoring_type: "performance" }, { slot: 2, scoring_type: "performance" }]), false);
});

test("competitors keep independent ordering within each division", () => {
  const rows = [competitor("Team 2", "Teams", 2), competitor("Solo 1", "Solo", 1), competitor("Team 1", "Teams", 1), competitor("Archived", "Teams", 3)];
  rows[3].archived = true;
  assert.deepEqual(divisionCompetitors(rows, "Teams").map((row) => [row.name, row.position]), [["Team 1", 1], ["Team 2", 2], ["Archived", 3]]);
  assert.deepEqual(divisionCompetitors(rows, "Solo").map((row) => [row.name, row.position]), [["Solo 1", 1]]);
});

test("division panel roster uses division assignments and internal organizer names", () => {
  const rows = divisionJudgeRoster("Teams", [competitor("a", "Teams", 1), competitor("b", "Solo", 1)], assignments, [], profiles);
  assert.deepEqual(rows.map(({ slot, name, scoring_type }) => ({ slot, name, scoring_type })), [
    { slot: 1, name: "Taylor Chen", scoring_type: "technical" },
    { slot: 2, name: "Morgan Lee", scoring_type: "technical" },
    { slot: 3, name: "Riley Shah", scoring_type: "performance" },
  ]);
});

test("competitor progress becomes complete only after every assigned judge submits", () => {
  const team = competitor("team", "Teams", 1, "active");
  const rows = [
    { competitor_id: "team", user_id: "t1", scoring_type: "technical" as const, roster_order: 1, display_name: "Taylor Chen", role_snapshot: "technical_judge", expected: true },
    { competitor_id: "team", user_id: "t2", scoring_type: "technical" as const, roster_order: 2, display_name: "Morgan Lee", role_snapshot: "technical_judge", expected: true },
    { competitor_id: "team", user_id: "p1", scoring_type: "performance" as const, roster_order: 3, display_name: "Riley Shah", role_snapshot: "performance_judge", expected: true },
  ];
  const partial = competitorProgress(team, assignments, rows, [
    submission("s1", "team", "t1", "technical", true),
    submission("s2", "team", "t2", "technical", true),
  ], profiles);
  assert.equal(partial.complete, false);
  assert.equal(partial.started, true);
  assert.deepEqual(partial.entries.map((entry) => entry.status), ["Submitted", "Submitted", "Pending"]);
  const complete = competitorProgress(team, assignments, rows, [
    submission("s1", "team", "t1", "technical", true),
    submission("s2", "team", "t2", "technical", true),
    submission("s3", "team", "p1", "performance", true),
  ], profiles);
  assert.equal(complete.complete, true);
  assert.equal(complete.entries.length, 3);
});
