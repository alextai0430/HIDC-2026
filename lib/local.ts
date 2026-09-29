import { openDB } from "idb";
import { Operation, Snapshot, Submission } from "./model";
import { normalizeAppearancePreferences, type AppearancePreferences } from "./appearance";
import { canViewOwnPerformancePoints } from "./scoped";
const database = () =>
  openDB("hidc-2026", 1, {
    upgrade(db) {
      db.createObjectStore("workspaces");
    },
  });
export type LocalWorkspace = {
  snapshot: Snapshot;
  queue: Operation[];
  appearancePending?: { preferences: AppearancePreferences; updatedAt: string } | null;
};
export async function readLocal(
  user: string,
): Promise<LocalWorkspace | undefined> {
  const db = await database();
  const value = await db.get("workspaces", user);
  if (!value) return undefined;
  const safe = sanitizeWorkspace(value);
  // Replace older cache entries that may predate the privacy boundary.
  await db.put("workspaces", safe, user);
  return safe;
}
export async function writeLocal(user: string, value: LocalWorkspace) {
  await (await database()).put("workspaces", sanitizeWorkspace(value), user);
}
// Delete only this immutable account ID's offline workspace.
export async function clearLocal(user: string) {
  await (await database()).delete("workspaces", user);
}
// Enforce privacy at the storage boundary, including for administrator judges.
export function sanitizeWorkspace(value: LocalWorkspace): LocalWorkspace {
  const cached = structuredClone(value);
  const snapshot = cached.snapshot;
  snapshot.profile.appearance_preferences = normalizeAppearancePreferences(snapshot.profile.appearance_preferences);
  if (cached.appearancePending) {
    cached.appearancePending.preferences = normalizeAppearancePreferences(cached.appearancePending.preferences);
  }
  // Signed avatar URLs are short-lived bearer links and must not persist in IndexedDB.
  delete snapshot.profile.avatar_url;
  snapshot.protected = false;
  snapshot.pointAccess = false;
  snapshot.submissions = snapshot.submissions
    .filter((s) => s.user_id === snapshot.profile.id)
    .map((s) => {
      const preservePerformance = canViewOwnPerformancePoints(snapshot.profile, s);
      if (!preservePerformance) delete s.total;
      s.events.forEach((e) => {
        delete e.value;
      });
      if (!preservePerformance) s.performance = [];
      return s;
    });
  delete snapshot.audit;
  delete snapshot.rankings;
  delete snapshot.profiles;
  snapshot.personal = snapshot.personal?.map(({ competitor_id, rank, total }) => {
    const ownPerformance = snapshot.submissions.some((submission) =>
      submission.competitor_id === competitor_id && canViewOwnPerformancePoints(snapshot.profile, submission));
    return { competitor_id, rank, ...(ownPerformance && total !== undefined ? { total } : {}) };
  });
  return cached;
}
export function applyLocal(snapshot: Snapshot, op: Operation): Snapshot {
  const state = structuredClone(snapshot);
  let s = state.submissions.find(
    (s) =>
      s.competitor_id === op.competitor_id && s.user_id === state.profile.id,
  );
  if (!s) {
    const assignment = state.assignments?.find((row) =>
      row.division === state.competitors.find((competitor) => competitor.id === op.competitor_id)?.division &&
      row.user_id === state.profile.id,
    );
    s = {
      id: crypto.randomUUID(),
      competitor_id: op.competitor_id,
      user_id: state.profile.id,
      slot: assignment?.slot ?? state.profile.slot ?? 1,
      scoring_type: assignment?.scoring_type ?? (state.profile.role === "performance_judge" ? "performance" : state.profile.role === "judge" && (state.profile.slot ?? 1) > 3 ? "performance" : "technical"),
      events: [],
      performance: [0, 0, 0, 0, 0, 0],
      finished: false,
      dq: false,
      version: 0,
      updated_at: new Date().toISOString(),
    };
    state.submissions.push(s);
  }
  const p = op.payload;
  if (op.kind === "put_event") {
    const event = p as unknown as Submission["events"][number];
    const index = s.events.findIndex((e) => e.id === event.id);
    if (index < 0) s.events.push(event);
    else s.events[index] = event;
  }
  if (op.kind === "delete_event")
    s.events = s.events.filter((e) => e.id !== p.id);
  if (op.kind === "performance") s.performance = p.values as number[];
  if (op.kind === "finish") {
    s.finished = p.finished as boolean;
    if (s.finished) s.submitted_at ??= new Date().toISOString();
  }
  if (op.kind === "dq") s.dq = p.dq as boolean;
  s.version++;
  s.updated_at = new Date().toISOString();
  delete s.total;
  return state;
}

/** Apply only this workspace's queued score actions over a fresh server snapshot. */
export function mergeRemoteSnapshotPreservingQueue(
  current: LocalWorkspace,
  remote: Snapshot,
): LocalWorkspace {
  if (current.snapshot.profile.id !== remote.profile.id) return current;
  const snapshot = current.queue.reduce(
    (merged, operation) => applyLocal(merged, operation),
    structuredClone(remote),
  );
  return { ...current, snapshot, queue: [...current.queue] };
}
