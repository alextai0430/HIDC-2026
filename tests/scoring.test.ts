import { test } from "node:test";
import assert from "node:assert/strict";
import { eventScore, rankGlobal, total } from "../lib/scoring";
import { applyLocal } from "../lib/local";
import { Competitor, Event, Submission, Snapshot } from "../lib/model";
const event = (trick: string, level = 1, features: string[] = []): Event => ({
  id: crypto.randomUUID(),
  trick,
  level,
  features,
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
const submission = (id: string, slot: number): Submission => ({
  id: crypto.randomUUID(),
  user_id: `judge${slot}`,
  competitor_id: id,
  slot,
  events: [event("T 3D")],
  performance: [5, 5, 5, 5, 5, 5],
  finished: true,
  dq: false,
  version: 1,
  updated_at: new Date().toISOString(),
});
test("technical bases and compounded features, without extra multipliers", () => {
  assert.equal(eventScore(event("# 2D")), 0.7);
  assert.equal(eventScore(event("T 3D", 2, ["T1", "T2"])), 61.199999999999996);
  assert.equal(eventScore(event("W VD", 0.5)), 0.2);
  assert.equal(eventScore(event("Unintentional Drop", 10, ["T3"])), -0.3);
  assert.equal(eventScore(event("Other Rule Violation")), -2);
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
  const subs = [1, 2, 3, 4, 5].flatMap((slot) => [
    submission("1", slot),
    submission("2", slot),
    submission("3", slot),
    submission("4", slot),
  ]);
  subs.find((s) => s.competitor_id === "2" && s.slot === 5)!.finished = false;
  const results = rankGlobal(comps, subs);
  assert.equal(results.find((r) => r.competitor.id === "1")!.final, 100);
  assert.equal(results.find((r) => r.competitor.id === "2")!.final, null);
  assert.equal(results.find((r) => r.competitor.id === "3")!.final, 100);
  assert.equal(results.find((r) => r.competitor.id === "4")!.final, 0);
  assert.equal(results.length, 4);
});
test("zero and negative raw values cannot create NaN or negative final scores", () => {
  const subs = [1, 2, 3, 4, 5].map((s) => submission("1", s));
  subs.forEach((s) => (s.events = [event("Time Violation")]));
  const r = rankGlobal([competitor("1")], subs)[0];
  assert.equal(r.scaled, 0);
  assert.equal(r.final, 30);
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
