import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLocal, mergeRemoteSnapshotPreservingQueue } from "../lib/local";
import { parsePerformancePayload } from "../lib/performance-patch";
import type { LocalWorkspace } from "../lib/local";
import type { Operation, Snapshot, Submission } from "../lib/model";

const profile = {
  id: "performance-judge",
  name: "Performance Judge",
  username: "performance",
  role: "performance_judge" as const,
  active: true,
};
const competitor = {
  id: "active-competitor",
  name: "Audit Competitor",
  division: "Audit Division",
  position: 1,
  status: "active" as const,
  dq: false,
  archived: false,
};
const submission = (performance: number[] = []) => ({
  id: "submission",
  competitor_id: competitor.id,
  user_id: profile.id,
  scoring_type: "performance" as const,
  slot: 1,
  events: [],
  performance,
  finished: false,
  dq: false,
  version: 0,
  updated_at: "2026-09-30T00:00:00.000Z",
}) satisfies Submission;
const snapshot = (saved: Submission = submission()): Snapshot => ({
  profile,
  competitors: [competitor],
  submissions: [saved],
  assignments: [{ division: competitor.division, slot: 1, user_id: profile.id, scoring_type: "performance" }],
  protected: false,
  pointAccess: false,
});
const operation = (id: string, payload: Record<string, unknown>): Operation => ({
  id,
  competitor_id: competitor.id,
  expected_version: 0,
  kind: "performance",
  payload,
  scoring_window_revision: "window-revision",
  scoring_window_token: "window-token",
});

test("Performance API contract accepts a single masked-safe category patch", () => {
  assert.deepEqual(parsePerformancePayload({ index: 4, value: 3.5 }), {
    patches: [{ index: 4, value: 3.5 }],
    recoveredLegacyPayload: false,
  });
});

test("legacy full and sparse/null-filled queued vectors recover only known categories", () => {
  assert.deepEqual(parsePerformancePayload({ values: [null, 2.5, null, 4] }), {
    patches: [{ index: 1, value: 2.5 }, { index: 3, value: 4 }],
    recoveredLegacyPayload: true,
  });
  const sparse: number[] = [];
  sparse[5] = 1.5;
  assert.deepEqual(parsePerformancePayload({ values: sparse }).patches, [{ index: 5, value: 1.5 }]);
  assert.equal(parsePerformancePayload({ values: [0, 1, 2, 3, 4, 5] }).patches.length, 6);
});

test("malformed, empty, all-masked, and out-of-range Performance operations are rejected", () => {
  for (const payload of [
    {},
    { index: 6, value: 3 },
    { index: 0, value: 2.25 },
    { values: [] },
    { values: [null, null] },
    { values: [1, 2, 3, 4, 5, 6] },
    { index: 1, value: 3, values: [1] },
  ]) {
    assert.throws(() => parsePerformancePayload(payload));
  }
});

test("masked local submission applies patches over six slots without changing server-owned hidden values", () => {
  const initial = snapshot(submission([]));
  const first = applyLocal(initial, operation("patch-1", { index: 2, value: 4.5 }));
  const second = applyLocal(first, operation("patch-2", { index: 5, value: 2 }));
  assert.deepEqual(second.submissions[0].performance, [0, 0, 4.5, 0, 0, 2]);
  assert.equal(initial.submissions[0].performance.length, 0, "the masked source snapshot remains unchanged");
});

test("offline queue replay preserves prior category patches and recovers old sparse operation payloads", () => {
  const legacyQueue = [
    operation("legacy-1", { values: [null, 2, null] }),
    { ...operation("legacy-2", { values: [null, 2, null, null, 4] }), expected_version: 1 },
  ];
  const workspace: LocalWorkspace = { snapshot: snapshot(), queue: legacyQueue };
  const remote = snapshot(submission([]));
  const merged = mergeRemoteSnapshotPreservingQueue(workspace, remote);
  assert.deepEqual(merged.snapshot.submissions[0].performance, [0, 2, 0, 0, 4, 0]);
  assert.deepEqual(merged.queue, legacyQueue, "queue recovery never drops the original operations");
});

test("an unrecoverable queued operation is retained and does not replace the cached vector", () => {
  const malformed = operation("legacy-unrecoverable", { values: [null, null] });
  const workspace: LocalWorkspace = { snapshot: snapshot(submission([])), queue: [malformed] };
  const merged = mergeRemoteSnapshotPreservingQueue(workspace, snapshot(submission([])));
  assert.deepEqual(merged.queue, [malformed]);
  assert.deepEqual(merged.snapshot.submissions[0].performance, []);
});
