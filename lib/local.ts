import { openDB } from "idb";
import { Operation, Snapshot, Submission } from "./model";
const database = () =>
  openDB("hidc-2026", 1, {
    upgrade(db) {
      db.createObjectStore("workspaces");
    },
  });
export type LocalWorkspace = { snapshot: Snapshot; queue: Operation[] };
export async function readLocal(
  user: string,
): Promise<LocalWorkspace | undefined> {
  return (await database()).get("workspaces", user);
}
export async function writeLocal(user: string, value: LocalWorkspace) {
  await (await database()).put("workspaces", value, user);
}
export function applyLocal(snapshot: Snapshot, op: Operation): Snapshot {
  const state = structuredClone(snapshot);
  let s = state.submissions.find(
    (s) =>
      s.competitor_id === op.competitor_id && s.user_id === state.profile.id,
  );
  if (!s) {
    s = {
      id: crypto.randomUUID(),
      competitor_id: op.competitor_id,
      user_id: state.profile.id,
      slot: state.profile.slot!,
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
  if (op.kind === "finish") s.finished = p.finished as boolean;
  if (op.kind === "dq") s.dq = p.dq as boolean;
  s.version++;
  s.updated_at = new Date().toISOString();
  delete s.total;
  return state;
}
