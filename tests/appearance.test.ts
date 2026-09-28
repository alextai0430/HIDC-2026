import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import {
  appearanceFonts,
  appearanceSchemes,
  appearanceTemplates,
  appearanceTokens,
  defaultAppearance,
  isAppearancePreferences,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from "../lib/appearance";
import { sanitizeWorkspace } from "../lib/local";
import type { Profile } from "../lib/model";

function load(file: string, overrides: Record<string, unknown>): any {
  const filename = resolve(file);
  const nativeRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const require = (name: string) => name in overrides
    ? overrides[name]
    : nativeRequire(name.startsWith("@/") ? resolve(name.slice(2)) : name);
  new Function("require", "module", "exports", source)(require, module, module.exports);
  return module.exports;
}

const actor = (id: string, appearance_updated_at = "2026-09-20T10:00:00.000Z"): Profile => ({
  id,
  name: id,
  username: id,
  role: id === "organizer" ? "server_admin" : "judge",
  slot: id === "organizer" ? null : 2,
  active: true,
  appearance_preferences: defaultAppearance,
  appearance_updated_at,
});
function appearanceRoute() {
  let actorProfile: ReturnType<typeof actor> = actor("judge2");
  const profiles = new Map<string, { preferences: AppearancePreferences; updatedAt: string }>();
  const currentFor = (id: string) => profiles.get(id) ?? {
    preferences: defaultAppearance,
    updatedAt: "2026-09-20T10:00:00.000Z",
  };
  const writeTargets: string[] = [];
  let beforeUpdate: (() => void) | null = null;
  const client = {
    from: () => {
      const query: any = { fields: "", updateValue: null, target: "", cutoff: "" };
      query.select = (fields: string) => { query.fields = fields; return query; };
      query.eq = (_field: string, value: string) => { query.target = value; return query; };
      query.lt = (_field: string, value: string) => { query.cutoff = value; return query; };
      query.update = (value: unknown) => { query.updateValue = value; return query; };
      query.single = async () => {
        const current = currentFor(actorProfile.id);
        return { data: { appearance_preferences: current.preferences, appearance_updated_at: current.updatedAt }, error: null };
      };
      query.maybeSingle = async () => {
        beforeUpdate?.();
        if (query.target !== actorProfile.id) return { data: null, error: null };
        writeTargets.push(query.target);
        const current = currentFor(query.target);
        const value = query.updateValue as { appearance_preferences: AppearancePreferences; appearance_updated_at: string };
        if (Date.parse(current.updatedAt) >= Date.parse(query.cutoff)) return { data: null, error: null };
        const updated = { preferences: value.appearance_preferences, updatedAt: value.appearance_updated_at };
        profiles.set(query.target, updated);
        return { data: { appearance_preferences: updated.preferences, appearance_updated_at: updated.updatedAt }, error: null };
      };
      return query;
    },
  };
  const handlers = load("app/api/profile/appearance/route.ts", {
    "@/lib/server": { identity: async () => {
      const current = currentFor(actorProfile.id);
      return { client, profile: { ...actorProfile, appearance_preferences: current.preferences, appearance_updated_at: current.updatedAt } };
    } },
    "@/lib/appearance": require("../lib/appearance"),
  });
  return {
    handlers,
    get current() { return currentFor(actorProfile.id); },
    set actor(value: ReturnType<typeof actor>) { actorProfile = value; },
    writeTargets,
    setBeforeUpdate(value: (() => void) | null) { beforeUpdate = value; },
    advance(value: AppearancePreferences, updatedAt: string) { profiles.set(actorProfile.id, { preferences: value, updatedAt }); },
  };
}

const request = (method: string, payload?: unknown) => new Request("http://localhost/api/profile/appearance", {
  method,
  headers: { "Content-Type": "application/json" },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});

function rgb(color: string): [number, number, number] {
  const hslColor = color.match(/^hsl\((\d+) (\d+)% (\d+)%\)$/);
  if (hslColor) {
    const h = Number(hslColor[1]) / 360;
    const s = Number(hslColor[2]) / 100;
    const l = Number(hslColor[3]) / 100;
    const hueToRgb = (p: number, q: number, t: number) => {
      let value = t;
      if (value < 0) value += 1;
      if (value > 1) value -= 1;
      if (value < 1 / 6) return p + (q - p) * 6 * value;
      if (value < 1 / 2) return q;
      if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
      return p;
    };
    if (s === 0) return [l, l, l].map((v) => Math.round(v * 255)) as [number, number, number];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)].map((v) => Math.round(v * 255)) as [number, number, number];
  }
  const channels = color.match(/[\da-f]{2}/gi);
  assert.equal(channels?.length, 3);
  return channels!.map((value) => Number.parseInt(value, 16)) as [number, number, number];
}
function luminance(color: string) {
  const values = rgb(color).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}
function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("all appearance choices have safe values for every theme combination", () => {
  assert.equal(appearanceTemplates.length, 5);
  assert.equal(appearanceSchemes.length, 35);
  assert.equal(appearanceFonts.length, 20);
  assert.equal(new Set(appearanceFonts.map((font) => font.css)).size, appearanceFonts.length);
  assert.ok(isAppearancePreferences(defaultAppearance));
  assert.deepEqual(normalizeAppearancePreferences({ template: "control-room", scheme: "hidc-navy", font: "system-ui", mode: "light" }), defaultAppearance);
  for (const mode of ["light", "dark"] as const) {
    assert.ok(new Set(appearanceSchemes.map((scheme) => appearanceTokens(scheme.id, mode)["--bg"])).size >= 34, `${mode} backgrounds are visually distinct`);
    assert.ok(new Set(appearanceSchemes.map((scheme) => appearanceTokens(scheme.id, mode)["--panel2"])).size >= 34, `${mode} input/panel surfaces are visually distinct`);
  }
  for (const template of appearanceTemplates)
    for (const scheme of appearanceSchemes)
      for (const font of appearanceFonts)
        for (const mode of ["light", "dark"] as const) {
          const preferences = { ...defaultAppearance, template: template.id, scheme: scheme.id, font: font.id, mode } as AppearancePreferences;
          assert.ok(isAppearancePreferences(preferences));
          const tokens = appearanceTokens(preferences.scheme, mode);
          const text = tokens["--text"];
          const muted = tokens["--muted"];
          assert.ok(contrast(text, tokens["--bg"]) >= 4.5, `${scheme.label} ${mode} body contrast`);
          assert.ok(contrast(text, tokens["--panel"]) >= 4.5, `${scheme.label} ${mode} panel text contrast`);
          assert.ok(contrast(text, tokens["--panel2"]) >= 4.5, `${scheme.label} ${mode} input text contrast`);
          assert.ok(contrast(muted, tokens["--bg"]) >= 4.5, `${scheme.label} ${mode} muted contrast`);
          assert.ok(contrast(muted, tokens["--panel2"]) >= 4.5, `${scheme.label} ${mode} muted input contrast`);
          assert.equal(tokens["--teal"], mode === "dark" ? scheme.darkAccent : scheme.accent);
        }
});

test("offline workspace cache keeps only the current user's appearance and queued updates", () => {
  const ownId = "judge-offline";
  const localChoice: AppearancePreferences = {
    template: "sidebar-workspace", scheme: "sand", font: "lato", mode: "system", sidebarCollapsed: true,
  };
  const cached = sanitizeWorkspace({
    snapshot: {
      profile: { ...actor(ownId), appearance_preferences: localChoice },
      competitors: [],
      submissions: [{
        id: "own-submission", competitor_id: "competitor", user_id: ownId,
        slot: 2, events: [{ id: "event", trick: "T 1D", level: 1, features: [], at: "2026-09-01T00:00:00Z", value: 1.2 }],
        performance: [1, 1, 1, 1, 1, 1], finished: false, dq: false, version: 1,
        updated_at: "2026-09-01T00:00:00Z", total: 99,
      }],
      protected: true,
      pointAccess: true,
      profiles: [actor("another-user")],
      audit: [{ id: 1 }],
      rankings: [],
      personal: [{ competitor_id: "competitor", rank: 1, total: 99 }],
    },
    queue: [],
    appearancePending: { preferences: localChoice, updatedAt: "2026-09-28T04:00:00.000Z" },
  });
  assert.deepEqual(cached.snapshot.profile.appearance_preferences, localChoice);
  assert.deepEqual(cached.appearancePending?.preferences, localChoice);
  assert.equal(cached.snapshot.profiles, undefined);
  assert.equal(cached.snapshot.audit, undefined);
  assert.equal(cached.snapshot.protected, false);
  assert.equal(cached.snapshot.pointAccess, false);
  assert.equal(cached.snapshot.submissions.length, 1);
  assert.equal(cached.snapshot.submissions[0].events[0].value, undefined);
  assert.equal(cached.snapshot.submissions[0].total, undefined);
});

test("appearance API serves and saves only the signed-in profile, without accepting a target ID", async () => {
  const fixture = appearanceRoute();
  const firstUpdatedAt = new Date(Date.now() + 30_000).toISOString();
  const secondUpdatedAt = new Date(Date.now() + 60_000).toISOString();
  const thirdUpdatedAt = new Date(Date.now() + 90_000).toISOString();
  const firstChoice: AppearancePreferences = {
    template: "focus-mode", scheme: "arctic", font: "atkinson-hyperlegible", mode: "dark", sidebarCollapsed: false,
  };
  const saved = await fixture.handlers.PATCH(request("PATCH", {
    preferences: firstChoice,
    updatedAt: firstUpdatedAt,
  }));
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  assert.match(saved.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await saved.json(), {
    saved: true,
    conflict: false,
    preferences: firstChoice,
    updatedAt: firstUpdatedAt,
  });
  assert.deepEqual(fixture.writeTargets, ["judge2"]);
  const fetched = await fixture.handlers.GET(request("GET"));
  assert.deepEqual(await fetched.json(), { preferences: firstChoice, updatedAt: firstUpdatedAt });
  fixture.actor = actor("judge3");
  assert.deepEqual(await (await fixture.handlers.GET(request("GET"))).json(), {
    preferences: defaultAppearance,
    updatedAt: "2026-09-20T10:00:00.000Z",
  });

  for (const id of ["alexandertai", "organizer"]) {
    fixture.actor = actor(id);
    const updated = await fixture.handlers.PATCH(request("PATCH", {
      preferences: { ...firstChoice, template: "classic-panel" },
      updatedAt: id === "alexandertai" ? secondUpdatedAt : thirdUpdatedAt,
    }));
    assert.equal(updated.status, 200);
    assert.equal(fixture.writeTargets.at(-1), id);
  }
  const tampered = await fixture.handlers.PATCH(request("PATCH", {
    profileId: "other-user",
    preferences: defaultAppearance,
    updatedAt: new Date(Date.now() + 120_000).toISOString(),
  }));
  assert.equal(tampered.status, 400);
  assert.equal(fixture.writeTargets.length, 3);
});

test("appearance API validates payloads and uses latest-save-wins on conflicts", async () => {
  const fixture = appearanceRoute();
  const invalid = await fixture.handlers.PATCH(request("PATCH", {
    preferences: { ...defaultAppearance, role: "server_admin" },
    updatedAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get("Content-Type") ?? "", /^application\/json\b/i);

  const ahead = await fixture.handlers.PATCH(request("PATCH", {
    preferences: defaultAppearance,
    updatedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }));
  assert.equal(ahead.status, 400);

  const stale = await fixture.handlers.PATCH(request("PATCH", {
    preferences: { ...defaultAppearance, scheme: "rose" },
    updatedAt: "2026-09-19T10:00:00.000Z",
  }));
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).conflict, true);
  assert.equal(fixture.writeTargets.length, 0);

  fixture.setBeforeUpdate(() => {
    fixture.setBeforeUpdate(null);
    fixture.advance({ ...defaultAppearance, scheme: "crimson" }, new Date(Date.now() + 90_000).toISOString());
  });
  const fresh = await fixture.handlers.PATCH(request("PATCH", {
    preferences: { ...defaultAppearance, scheme: "forest" },
    updatedAt: new Date(Date.now() + 45_000).toISOString(),
  }));
  assert.equal(fresh.status, 200, JSON.stringify(await fresh.clone().json()));
  const raceResult = await fresh.json();
  assert.equal(raceResult.conflict, true);
  assert.equal(raceResult.preferences.scheme, "crimson");

  const empty = await fixture.handlers.PATCH(new Request("http://localhost/api/profile/appearance", { method: "PATCH", body: "{" }));
  assert.equal(empty.status, 400);
  assert.ok((await empty.json()).error);
  const unsupported = await fixture.handlers.DELETE(request("DELETE"));
  assert.equal(unsupported.status, 405);
  assert.ok((await unsupported.json()).error);
});
