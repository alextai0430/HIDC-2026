import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLocal, mergeRemoteSnapshotPreservingQueue, rebaseQueuedOperationsToOpenWindow } from "../lib/local";
import type { LocalWorkspace } from "../lib/local";
import type { Competitor, Operation, Profile, Snapshot, Submission } from "../lib/model";

const profile: Profile = {
  id: "judge-id",
  name: "Taylor Chen",
  username: "taylor",
  role: "technical_judge",
  active: true,
};

test("live refresh adopts a newly active competitor without losing queued score work", () => {
  const competitor: Competitor = {
    id: "new-competitor",
    name: "First Competitor",
    division: "Individual Open",
    position: 1,
    status: "active",
    dq: false,
    archived: false,
  };
  const remoteSubmission: Submission = {
    id: "submission-id",
    competitor_id: competitor.id,
    user_id: profile.id,
    slot: 1,
    scoring_type: "technical",
    events: [],
    performance: [],
    finished: false,
    dq: false,
    version: 0,
    updated_at: "2026-09-28T12:00:00.000Z",
  };
  const pendingEvent = {
    id: "offline-event",
    trick: "T 1D",
    level: 1,
    features: [],
    execution: "E0" as const,
    at: "2026-09-28T12:01:00.000Z",
  };
  const operation: Operation = {
    id: "queued-operation",
    competitor_id: competitor.id,
    expected_version: 0,
    kind: "put_event",
    payload: pendingEvent,
  };
  const local: LocalWorkspace = {
    snapshot: {
      profile,
      competitors: [],
      submissions: [],
      protected: false,
    },
    queue: [operation],
  };
  const remote: Snapshot = {
    profile,
    competitors: [competitor],
    submissions: [remoteSubmission],
    assignments: [{ division: competitor.division, slot: 1, user_id: profile.id, scoring_type: "technical" }],
    protected: false,
  };

  const merged = mergeRemoteSnapshotPreservingQueue(local, remote);
  assert.equal(merged.snapshot.competitors[0].id, competitor.id);
  assert.equal(merged.snapshot.competitors[0].status, "active");
  assert.equal(merged.snapshot.submissions[0].events[0].id, pendingEvent.id);
  assert.deepEqual(merged.queue, [operation]);
});

test("live refresh cannot replace a cached workspace with another account's snapshot", () => {
  const local: LocalWorkspace = {
    snapshot: { profile, competitors: [], submissions: [], protected: false },
    queue: [],
  };
  const other: Snapshot = {
    profile: { ...profile, id: "other-judge" },
    competitors: [],
    submissions: [],
    protected: false,
  };
  assert.equal(mergeRemoteSnapshotPreservingQueue(local, other), local);
});

test("offline actions rebase only after an explicit reopen and use the server submission version", () => {
  const queue: Operation[] = [
    { id: "queued-1", competitor_id: "reopened", expected_version: 2, kind: "put_event", payload: { id: "event-1" }, scoring_window_revision: "old-revision", scoring_window_token: "old-token" },
    { id: "queued-2", competitor_id: "reopened", expected_version: 3, kind: "delete_event", payload: { id: "event-1" }, scoring_window_revision: "old-revision", scoring_window_token: "old-token" },
  ];
  const rebased = rebaseQueuedOperationsToOpenWindow(queue, "reopened", { revision: "new-revision", token: "new-token" }, 7);
  assert.deepEqual(rebased?.map(({ expected_version, scoring_window_revision, scoring_window_token }) => ({ expected_version, scoring_window_revision, scoring_window_token })), [
    { expected_version: 7, scoring_window_revision: "new-revision", scoring_window_token: "new-token" },
    { expected_version: 8, scoring_window_revision: "new-revision", scoring_window_token: "new-token" },
  ]);
  assert.equal(queue[0].scoring_window_revision, "old-revision", "the saved source queue remains untouched");
  assert.equal(rebaseQueuedOperationsToOpenWindow([...queue, { ...queue[0], id: "other", competitor_id: "different" }], "reopened", { revision: "new-revision", token: "new-token" }, 7), null);
});

test("offline submit immediately locks the cached submission and records its submit time", () => {
  const competitor: Competitor = {
    id: "active-competitor",
    name: "Active Competitor",
    division: "Individual Open",
    position: 1,
    status: "active",
    dq: false,
    archived: false,
  };
  const submission: Submission = {
    id: "active-submission",
    competitor_id: competitor.id,
    user_id: profile.id,
    slot: 1,
    scoring_type: "technical",
    events: [],
    performance: [],
    finished: false,
    dq: false,
    version: 0,
    updated_at: "2026-09-28T12:00:00.000Z",
  };
  const snapshot: Snapshot = {
    profile,
    competitors: [competitor],
    submissions: [submission],
    assignments: [{ division: competitor.division, slot: 1, user_id: profile.id, scoring_type: "technical" }],
    protected: false,
  };
  const submitted = applyLocal(snapshot, {
    id: "submit-operation",
    competitor_id: competitor.id,
    expected_version: 0,
    kind: "finish",
    payload: { finished: true },
  });

  assert.equal(submitted.submissions[0].finished, true);
  assert.equal(typeof submitted.submissions[0].submitted_at, "string");
});
