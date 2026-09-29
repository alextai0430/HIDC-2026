import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

function load(file: string, overrides: Record<string, unknown>): any {
  const filename = resolve(file);
  const nativeRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const require = (name: string) => name in overrides ? overrides[name] : nativeRequire(name.startsWith("@/") ? resolve(name.slice(2)) : name);
  new Function("require", "module", "exports", source)(require, module, module.exports);
  return module.exports;
}

type Actor = { id: string; name: string; username: string; role: string; active: boolean };
const defaults = { enabled: true, keys: { "T 1D": "t", "level:next": "l" } };
type Preferences = { enabled: boolean; keys: Record<string, string> };
function fixture() {
  let currentActor: Actor = { id: "judge-one", name: "Judge One", username: "judgeone", role: "technical_judge", active: true };
  const records = new Map<string, { preferences: Preferences; updatedAt: string }>();
  const writes: string[] = [];
  const client = {
    from: () => {
      const query: any = { target: "", cutoff: "", updateValue: null };
      query.update = (value: unknown) => { query.updateValue = value; return query; };
      query.eq = (_field: string, value: string) => { query.target = value; return query; };
      query.lt = (_field: string, value: string) => { query.cutoff = value; return query; };
      query.select = () => query;
      query.maybeSingle = async () => {
        if (query.target !== currentActor.id) return { data: null, error: null };
        const current = records.get(currentActor.id) ?? { preferences: defaults, updatedAt: "2026-01-01T00:00:00.000Z" };
        if (Date.parse(current.updatedAt) >= Date.parse(query.cutoff)) return { data: null, error: null };
        const input = query.updateValue as { hotkey_preferences: Preferences; hotkeys_updated_at: string };
        records.set(currentActor.id, { preferences: input.hotkey_preferences, updatedAt: input.hotkeys_updated_at });
        writes.push(currentActor.id);
        return { data: { hotkey_preferences: input.hotkey_preferences, hotkeys_updated_at: input.hotkeys_updated_at }, error: null };
      };
      query.single = async () => {
        const row = records.get(currentActor.id) ?? { preferences: defaults, updatedAt: "2026-01-01T00:00:00.000Z" };
        return { data: { hotkey_preferences: row.preferences, hotkeys_updated_at: row.updatedAt }, error: null };
      };
      return query;
    },
  };
  const handlers = load("app/api/profile/hotkeys/route.ts", {
    "@/lib/server": { identity: async () => ({ client, profile: { ...currentActor, ...(records.get(currentActor.id) ? {
      hotkey_preferences: records.get(currentActor.id)!.preferences,
      hotkeys_updated_at: records.get(currentActor.id)!.updatedAt,
    } : {}) } }) },
  });
  const request = (method: string, payload?: unknown) => new Request("http://localhost/api/profile/hotkeys", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    handlers,
    request,
    writes,
    setActor(value: Actor) { currentActor = value; },
  };
}

test("hotkeys persist only on the signed-in profile for judges and organizers", async () => {
  const f = fixture();
  const preferences = { enabled: false, keys: { "T 1D": "q", "level:next": "w" } };
  const updatedAt = new Date(Date.now() + 20_000).toISOString();
  for (const actor of [
    { id: "judge-one", name: "Judge One", username: "judgeone", role: "technical_judge", active: true },
    { id: "alexandertai", name: "Alex", username: "alexandertai", role: "organizer", active: true },
    { id: "organizer", name: "Organizer", username: "organizer", role: "organizer", active: true },
  ]) {
    f.setActor(actor);
    const response = await f.handlers.PATCH(f.request("PATCH", { preferences, updatedAt }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
    assert.deepEqual((await response.json()).preferences, preferences);
    assert.equal(f.writes.at(-1), actor.id);
    assert.deepEqual(await (await f.handlers.GET(f.request("GET"))).json(), { preferences, updatedAt });
  }
  f.setActor({ id: "judge-one", name: "Judge One", username: "judgeone", role: "technical_judge", active: true });
  assert.deepEqual((await f.handlers.GET(f.request("GET"))).status, 200);
  assert.equal(f.writes.filter((id) => id === "judge-one").length, 1);
});

test("hotkeys reject cross-profile fields, duplicate bindings, and malformed JSON", async () => {
  const f = fixture();
  const updatedAt = new Date(Date.now() + 10_000).toISOString();
  const crossProfile = await f.handlers.PATCH(f.request("PATCH", { profileId: "other", preferences: defaults, updatedAt }));
  assert.equal(crossProfile.status, 400);
  assert.match((await crossProfile.json()).error, /valid, unique/i);
  const duplicates = await f.handlers.PATCH(f.request("PATCH", { preferences: { enabled: true, keys: { a: "x", b: " X " } }, updatedAt }));
  assert.equal(duplicates.status, 400);
  const malformed = await f.handlers.PATCH(new Request("http://localhost/api/profile/hotkeys", { method: "PATCH", body: "{" }));
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.deepEqual(f.writes, []);
});
