import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import * as access from "../lib/access";
import { sanitizeAuditRows } from "../lib/audit";
import { hashAdminTabPassword } from "../lib/admin-password";
import {
  createAdminUnlockToken,
  hasValidAdminUnlock,
} from "../lib/admin-unlock";
import {
  sanitizeWorkspace,
  applyLocal,
  type LocalWorkspace,
} from "../lib/local";
import type { Profile, Submission } from "../lib/model";
import { DEFAULT_SCORING_RULES } from "../lib/scoring-config";
import {
  detailExportRows,
  detailSubmissions,
  ownSubmissions,
  personalScoreExportRows,
} from "../lib/scoped";

const alex: Profile = {
  id: crypto.randomUUID(),
  username: "alexandertai",
  name: "alexandertai",
  role: "judge",
  slot: 1,
  active: true,
  is_admin: true,
};
const organizer: Profile = {
  ...alex,
  id: crypto.randomUUID(),
  username: "organizer",
  role: "server_admin",
  slot: null,
};
const judges = [2, 3, 4, 5].map((slot) => ({
  ...alex,
  id: crypto.randomUUID(),
  username: `judge${slot}`,
  slot,
  is_admin: false,
}));
const protectedPolicy = { ...access };

// Execute the real server/route code, replacing only external services. No live credentials or network.
function load(file: string, overrides: Record<string, unknown>): any {
  const filename = resolve(file);
  const nativeRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (name: string) =>
    name in overrides
      ? overrides[name]
      : nativeRequire(name.startsWith("@/") ? resolve(name.slice(2)) : name);
  new Function("require", "module", "exports", source)(
    require,
    module,
    module.exports,
  );
  return module.exports;
}
const server = load("lib/server.ts", {
  "server-only": {},
  "./access": protectedPolicy,
  "next/headers": { cookies: async () => ({ get: () => undefined }) },
});
function route(name: string, profile: Profile, client: unknown) {
  return load(`app/api/${name}/route.ts`, {
    "@/lib/access": protectedPolicy,
    "@/lib/server": { ...server, identity: async () => ({ profile, client }) },
  });
}
const request = (body: unknown, url = "http://localhost/api/test") =>
  new Request(url, { method: "POST", body: JSON.stringify(body) });

test("administrator identity and judge scoring remain independent, including legacy cache profiles", async () => {
  for (const p of [alex, organizer]) {
    assert.equal(access.canManage(p), true);
    assert.equal(access.canEditJudge(p), false);
  }
  assert.equal(access.isAssignedJudge(alex), true);
  assert.equal(alex.slot, 1);
  assert.equal(access.isAssignedJudge(organizer), false);
  const serverJudge: Profile = {
    ...alex,
    role: "server_admin",
    is_admin: false,
  };
  assert.equal(access.canManage(serverJudge), true);
  assert.equal(access.isAssignedJudge(serverJudge), false);
  for (const p of judges) {
    assert.equal(access.canManage(p), false);
    assert.equal(access.canEditJudge(p), true);
  }
  assert.equal(access.canManage({ ...alex, is_admin: undefined }), false);
  assert.equal(access.canManage({ ...alex, active: false }), false);
});

test("Admin score-view password is checked server-side for every signed-in account", async () => {
  const previous = process.env.ADMIN_VIEW_PASSWORD;
  const previousSigningSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.ADMIN_VIEW_PASSWORD = "ndladm";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-signing-secret-0123456789abcdef";
  try {
    for (const profile of [...judges, alex, organizer]) {
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      const handlers = route("verify-admin", profile, {
        from: () => query,
      });
      assert.equal(
        (await handlers.POST(request({ password: "wrong" }))).status,
        401,
      );
      const authorized = await handlers.POST(request({ password: "ndladm" }));
      assert.equal(authorized.status, 200);
      const { unlockToken } = await authorized.json();
      assert.equal(hasValidAdminUnlock(unlockToken, profile.id), true);
      assert.equal(
        hasValidAdminUnlock(
          unlockToken,
          profile.id === organizer.id ? alex.id : organizer.id,
        ),
        false,
      );
    }
    const hashed = hashAdminTabPassword("changed-shared-password");
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({
        data: { next: { password_hash: hashed } },
        error: null,
      }),
    };
    const verify = route("verify-admin", judges[0], {
      from: () => query,
    }).POST;
    assert.equal(
      (await verify(request({ password: "ndladm" }))).status,
      401,
    );
    assert.equal(
      (await verify(request({ password: "changed-shared-password" }))).status,
      200,
    );
  } finally {
    if (previous === undefined) delete process.env.ADMIN_VIEW_PASSWORD;
    else process.env.ADMIN_VIEW_PASSWORD = previous;
    if (previousSigningSecret === undefined)
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousSigningSecret;
  }
});

test("Admin unlock tokens are signed, profile-bound, and expire after the page-session window", () => {
  const previousSigningSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-signing-secret-0123456789abcdef";
  try {
    const token = createAdminUnlockToken(alex.id);
    assert.equal(hasValidAdminUnlock(token, alex.id), true);
    assert.equal(hasValidAdminUnlock(token, organizer.id), false);
    assert.equal(hasValidAdminUnlock(`${token}x`, alex.id), false);
  } finally {
    if (previousSigningSecret === undefined)
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousSigningSecret;
  }
});

test("only administrators can change the shared Admin-tab password", async () => {
  for (const actor of [alex, organizer]) {
    let saved: any;
    const response = await route("admin-tab-password", actor, {
      from: () => ({
        insert: async (row: unknown) => {
          saved = row;
          return { error: null };
        },
      }),
    }).POST(request({ password: "changed-shared-password" }));
    assert.equal(response.status, 200);
    assert.equal(saved.user_id, actor.id);
    assert.equal(saved.action, "admin_tab_password_change");
    assert.notEqual(saved.next.password_hash, "changed-shared-password");
  }
  const blocked = await route("admin-tab-password", judges[0], {}).POST(
    request({ password: "changed-shared-password" }),
  );
  assert.equal(blocked.status, 400);
});

test("admin password hashes are omitted from audit responses", () => {
  const rows = sanitizeAuditRows([
    {
      id: 1,
      action: "admin_tab_password_change",
      prior: null,
      next: { password_hash: "private-hash" },
    },
    { id: 2, action: "division_create", prior: null, next: { name: "Open" } },
  ]);
  assert.deepEqual(rows[0].next, { password_changed: true });
  assert.deepEqual(rows[1].next, { name: "Open" });
});

test("management, review, and audit reject judges 2–5 before database access", async () => {
  const client = new Proxy(
    {},
    {
      get() {
        throw new Error("Unexpected database access");
      },
    },
  );
  for (const judge of judges) {
    for (const name of ["manage", "review", "audit"]) {
      const handlers = route(name, judge, client);
      const response = await (handlers.POST ?? handlers.GET)(
        request({ action: "division", data: { name: "Forbidden" } }),
      );
      assert.equal(response.status, 400);
      assert.match(
        (await response.json()).error,
        /access required|unlock required/,
      );
    }
  }
});

test("division creation reports an existing division clearly instead of surfacing a database key error", async () => {
  let inserts = 0;
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: { name: "Exhibition" }, error: null }),
    insert: async () => {
      inserts += 1;
      return { error: { code: "23505", message: "duplicate key value violates unique constraint divisions_pkey" } };
    },
  };
  const response = await route("manage", alex, { from: () => builder }).POST(
    request({ action: "division", data: { name: "Exhibition" } }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /already exists.*Division list/i);
  assert.equal(inserts, 0, "duplicate preflight must prevent an insert");
});

test("Judge 1 submits technical scores with unchanged attribution; backup organizer cannot score", async () => {
  const calls: any[] = [];
  const client = {
    rpc: async (...args: any[]) => {
      calls.push(args);
      return { data: { ok: true } };
    },
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: table === "scoring_configuration"
            ? { revision: 1, rules: DEFAULT_SCORING_RULES }
            : null,
          error: null,
        }),
      };
      return builder;
    },
  };
  const body = {
    id: crypto.randomUUID(),
    competitor_id: crypto.randomUUID(),
    expected_version: 7,
    kind: "put_event",
    payload: {
      id: crypto.randomUUID(),
      trick: "T 3D",
      level: 2,
      features: ["T1"],
      at: new Date().toISOString(),
    },
  };
  assert.equal(
    (await route("sync", alex, client).POST(request(body))).status,
    200,
  );
  assert.equal(calls[0][0], "apply_score");
  assert.equal(calls[0][1].p_user, alex.id);
  assert.equal(calls[0][1].p_slot, 1);
  assert.equal(calls[0][1].p_version, 7);
  assert.equal(
    (await route("sync", organizer, client).POST(request(body))).status,
    400,
  );
  assert.equal(calls.length, 1);
});

test("both administrators can activate, lock, review and create divisions", async () => {
  for (const p of [alex, organizer]) {
    const calls: any[] = [];
    const client = {
      rpc: async (...args: any[]) => {
        calls.push(args);
        return {};
      },
      from: (table: string) => {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: async (data: unknown) => {
            calls.push([table, data]);
            return { error: null };
          },
        };
        return builder;
      },
    };
    for (const action of ["activate", "lock"]) {
      assert.equal(
        (
          await route("manage", p, client).POST(
            request({ action, data: { id: crypto.randomUUID() } }),
          )
        ).status,
        200,
      );
    }
    assert.equal(calls[0][1].p_development, false);
    assert.equal(calls[0][1].p_actor, p.id);
    assert.equal(
      (
        await route("manage", p, client).POST(
          request({ action: "division", data: { name: "Test Division" } }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await route("review", p, client).POST(
          request({
            id: crypto.randomUUID(),
            version: 1,
            finished: true,
            dq: false,
          }),
        )
      ).status,
      200,
    );
  }
});

test("normal account management cannot edit, deactivate, reassign or demote either administrator", async () => {
  for (const target of [alex, organizer]) {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      maybeSingle: async () => ({ data: null }),
      single: async () => ({ data: target }),
    };
    const client = {
      from: () => builder,
      auth: new Proxy(
        {},
        {
          get() {
            throw new Error("Must not change administrator credentials");
          },
        },
      ),
    };
    const response = await route("manage", alex, client).POST(
      request({
        action: "user",
        data: {
          id: target.id,
          username: "renamed",
          slot: 5,
          active: false,
          is_admin: false,
          password: "123456",
        },
      }),
    );
    assert.equal(response.status, 400);
    assert.match(
      (await response.json()).error,
      /Administrator accounts are protected/,
    );
  }
});

test("state endpoint masks score data until unlock and only returns own judge points or global admin points", async () => {
  const competitor = {
    id: crypto.randomUUID(),
    name: "Test",
    division: "Individual Open",
    position: 1,
    status: "active" as const,
    archived: false,
    dq: false,
  };
  const futureCompetitor = {
    id: crypto.randomUUID(),
    name: "Future competitor",
    division: "Team Division",
    position: 2,
    status: "upcoming",
    archived: false,
    dq: false,
  };
  const profiles = [alex, ...judges, organizer];
  const liveRules = structuredClone(DEFAULT_SCORING_RULES);
  liveRules.bases.T["3D"] = 9;
  const submissions = [alex, ...judges].map((p) => ({
    id: crypto.randomUUID(),
    competitor_id: competitor.id,
    user_id: p.id,
    slot: p.slot,
    events: [
      {
        id: crypto.randomUUID(),
        trick: "T 3D",
        level: 1,
        features: [],
        at: new Date().toISOString(),
      },
    ],
    performance: [5, 5, 5, 5, 5, 5],
    finished: true,
    dq: false,
    version: 1,
  }));
  const serverJudge: Profile = {
    ...alex,
    id: crypto.randomUUID(),
    username: "serverjudge1",
    role: "server_admin",
    slot: 1,
    is_admin: false,
  };
  const previousSigningSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-signing-secret-0123456789abcdef";
  try {
  for (const p of [...profiles, serverJudge]) {
    const client = {
      from(table: string) {
        let data: any[] =
          table === "competitors"
            ? [competitor, futureCompetitor]
            : table === "submissions"
              ? [...submissions]
              : table === "division_judges"
                ? profiles.filter((row) => row.role === "judge").flatMap((row) => [
                    { division: "Individual Open", slot: row.slot, user_id: row.id },
                    { division: "Team Division", slot: row.slot, user_id: row.id },
                  ])
              : table === "profiles"
                ? profiles.map((row) => ({
                    ...row,
                    avatar_path: `${row.id}/private-avatar.png`,
                  }))
                : table === "audit"
                  ? [{ action: "put_event", prior: { value: 5 }, next: { value: 6 } }]
                  : table === "scoring_configuration"
                    ? [{ config_id: "global", revision: 2, data_revision: 9, rules: liveRules }]
                  : [{ name: "Individual Open" }];
        const builder: any = {
          select: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
          lte: (field: string, value: unknown) => {
            data = data.filter((row) => row[field] <= Number(value));
            return builder;
          },
          eq: (field: string, value: unknown) => {
            data = data.filter((row) => row[field] === value);
            return builder;
          },
          then: (done: (v: unknown) => unknown) =>
            Promise.resolve({ data }).then(done),
        };
        return builder;
      },
      storage: {
        from: () => ({
          createSignedUrl: async (path: string) => ({
            data: { signedUrl: `https://signed.invalid/${path}` },
            error: null,
          }),
        }),
      },
    };
    const response = await route("state", p, client).GET(
      new Request(
        `http://localhost/api/state?user_id=${alex.id}&include_all=true`,
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const hiddenBody = await response.json();
    assert.equal(hiddenBody.pointAccess, false);
    for (const submission of hiddenBody.submissions) {
      const ownPerformance = p.role === "judge" && submission.user_id === p.id && (submission.scoring_type ?? (submission.slot > 3 ? "performance" : "technical")) === "performance";
      assert.equal(submission.total, ownPerformance ? 30 : undefined);
      assert.deepEqual(submission.performance, ownPerformance ? [5, 5, 5, 5, 5, 5] : []);
      assert.equal(submission.events[0].value, undefined);
    }
    if (p.role === "judge" && (p.slot ?? 0) > 3 && !access.isAdministrator(p)) {
      assert.equal(hiddenBody.personal[0].total, 30);
    }
    if (access.isAdministrator(p)) {
      assert.equal(hiddenBody.protected, true);
      assert.equal(hiddenBody.submissions.length, 5);
      assert.equal(hiddenBody.rankings, undefined);
      assert.equal(hiddenBody.audit.length, 1);
      assert.deepEqual(hiddenBody.audit[0].next, { redacted: true });
      assert.equal(hiddenBody.profiles.length, 6);
      for (const metadata of hiddenBody.profiles) {
        assert.equal(metadata.avatar_path, undefined);
        assert.equal(metadata.email, undefined);
        assert.equal(metadata.password, undefined);
        assert.equal(metadata.password_hash, undefined);
        assert.match(metadata.avatar_url, /^https:\/\/signed\.invalid\//);
      }
    } else {
      assert.equal(hiddenBody.protected, false);
      assert.equal(hiddenBody.submissions.length, 1);
      assert.equal(hiddenBody.submissions[0].user_id, p.id);
      assert.equal(hiddenBody.rankings, undefined);
      assert.equal(hiddenBody.audit, undefined);
      assert.equal(hiddenBody.profiles, undefined);
      assert.deepEqual(hiddenBody.competitors.map((row: any) => row.id), [competitor.id]);
      assert.equal(hiddenBody.profile.avatar_path, undefined);
      assert.equal(hiddenBody.profile.password, undefined);
      assert.equal(hiddenBody.profile.password_hash, undefined);
    }

    const unlockToken = createAdminUnlockToken(p.id);
    const unlocked = await route("state", p, client).GET(
      new Request("http://localhost/api/state", {
        headers: { "x-hidc-admin-unlock": unlockToken },
      }),
    );
    assert.equal(unlocked.status, 200);
    const visibleBody = await unlocked.json();
    assert.equal(visibleBody.pointAccess, true);
    for (const saved of visibleBody.submissions.filter((row: any) => row.slot <= 3)) {
      assert.equal(saved.total, 9);
      assert.equal(saved.events[0].value, 9);
    }
    const ownExport = personalScoreExportRows(p, visibleBody.submissions, [competitor], true);
    if (p.slot !== null && p.slot <= 3 && ownExport.length > 0) {
      const technicalExport = ownExport[0];
      assert.ok("Events" in technicalExport);
      assert.equal(technicalExport.Total, 9);
      assert.equal((JSON.parse(technicalExport.Events as string) as any)[0].points, 9);
    }
    if (access.isAdministrator(p)) {
      assert.equal(visibleBody.submissions.length, 5);
      assert.equal(visibleBody.submissions[0].total, 9);
      assert.equal(visibleBody.rankings.length, 2);
      assert.equal(visibleBody.rankings[0].technical[0], 9);
      assert.equal(visibleBody.audit.length, 1);
    } else {
      assert.equal(visibleBody.submissions.length, 1);
      assert.equal(visibleBody.submissions[0].user_id, p.id);
      assert.equal(visibleBody.submissions[0].total, p.slot! <= 3 ? 9 : 30);
      assert.equal(visibleBody.submissions[0].events[0].value, 9);
      assert.equal(visibleBody.rankings, undefined);
      assert.equal(visibleBody.audit, undefined);
    }
  }
  } finally {
    if (previousSigningSecret === undefined)
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousSigningSecret;
  }
});

test("technical point configuration requires the allowlist and active Admin unlock, then previews before updating", async () => {
  const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-signing-secret-0123456789abcdef";
  try {
    const competitor = {
      id: crypto.randomUUID(),
      name: "Toss test",
      division: "Individual Open",
      position: 1,
      status: "locked" as const,
      dq: false,
      archived: false,
    };
    const savedEvent = {
      id: crypto.randomUUID(),
      trick: "T 1D",
      level: 1,
      features: [],
      at: new Date().toISOString(),
    };
    const submission: Submission = {
      id: crypto.randomUUID(),
      competitor_id: competitor.id,
      user_id: alex.id,
      slot: 1,
      events: [savedEvent],
      performance: [],
      finished: true,
      dq: false,
      version: 1,
      updated_at: new Date().toISOString(),
    };
    let config = { revision: 1, rules: structuredClone(DEFAULT_SCORING_RULES) };
    const rpcCalls: unknown[][] = [];
    const auditRows: any[] = [];
    const client = {
      from(table: string) {
        let data: any[] = table === "scoring_configuration"
          ? [{ config_id: "global", ...config }]
          : table === "submissions"
            ? [submission]
            : table === "competitors"
              ? [competitor]
              : table === "audit"
                ? auditRows
              : [];
        const builder: any = {
          select: () => builder,
          eq: (field: string, value: unknown) => {
            data = data.filter((row) => row[field] === value);
            return builder;
          },
          lte: (field: string, value: number) => {
            data = data.filter((row) => row[field] <= value);
            return builder;
          },
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
          then: (resolve: (result: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve({ data, error: null }).then(resolve, reject),
        };
        return builder;
      },
      rpc: async (name: string, args: Record<string, any>) => {
        rpcCalls.push([name, args]);
        auditRows.push({
          created_at: new Date().toISOString(),
          action: "scoring_configuration_update",
          prior: { revision: config.revision, rules: structuredClone(config.rules) },
        });
        config = { revision: config.revision + 1, rules: args.p_rules };
        return {
          data: {
            changed: true,
            revision: config.revision,
            rules: config.rules,
            impact: args.p_impact,
          },
          error: null,
        };
      },
    };
    const handlers = route("scoring-configuration", alex, client);
    const withoutUnlock = await handlers.GET(new Request("http://localhost/api/scoring-configuration"));
    assert.equal(withoutUnlock.status, 403);

    for (const account of [alex, organizer]) {
      const token = createAdminUnlockToken(account.id);
      const response = await route("scoring-configuration", account, client).GET(
        new Request("http://localhost/api/scoring-configuration", {
          headers: { "x-hidc-admin-unlock": token },
        }),
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.revision, 1);
      assert.deepEqual(body.previousRevisions, []);
    }
    for (const account of [...judges, { ...alex, username: "serverjudge1", role: "server_admin" as const }]) {
      const token = createAdminUnlockToken(account.id);
      const response = await route("scoring-configuration", account, client).GET(
        new Request("http://localhost/api/scoring-configuration", {
          headers: { "x-hidc-admin-unlock": token },
        }),
      );
      assert.equal(response.status, 403);
    }

    const token = createAdminUnlockToken(alex.id);
    const rules = structuredClone(DEFAULT_SCORING_RULES);
    rules.bases.T["1D"] = 3;
    const previewResponse = await route("scoring-configuration", alex, client).POST(
      new Request("http://localhost/api/scoring-configuration", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hidc-admin-unlock": token },
        body: JSON.stringify({ action: "preview", expectedRevision: 1, rules }),
      }),
    );
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.deepEqual(preview.impact, {
      technicalSubmissions: 1,
      technicalEventValues: 1,
      competitors: 1,
      rankingDivisions: 1,
      finalizedRankings: 0,
    });
    assert.equal(rpcCalls.length, 0, "preview/cancel must not write scoring rules");

    const missingConfirmation = await route("scoring-configuration", alex, client).POST(
      new Request("http://localhost/api/scoring-configuration", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hidc-admin-unlock": token },
        body: JSON.stringify({
          action: "update",
          expectedRevision: 1,
          expectedDataRevision: preview.dataRevision,
          rules,
          impact: preview.impact,
          confirmation: "",
        }),
      }),
    );
    assert.equal(missingConfirmation.status, 400);
    assert.equal(rpcCalls.length, 0);

    const confirmed = await route("scoring-configuration", alex, client).POST(
      new Request("http://localhost/api/scoring-configuration", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hidc-admin-unlock": token },
        body: JSON.stringify({
          action: "update",
          expectedRevision: 1,
          expectedDataRevision: preview.dataRevision,
          rules,
          impact: preview.impact,
          confirmation: "UPDATE POINT VALUES",
        }),
      }),
    );
    assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.json()));
    assert.equal(rpcCalls.length, 1);
    assert.equal(config.revision, 2);
    assert.deepEqual(submission.events, [savedEvent], "rule changes preserve score selections and timestamps");
    const restoredHistory = await route("scoring-configuration", alex, client).GET(
      new Request("http://localhost/api/scoring-configuration", {
        headers: { "x-hidc-admin-unlock": token },
      }),
    );
    assert.equal(restoredHistory.status, 200);
    assert.deepEqual((await restoredHistory.json()).previousRevisions.map((entry: any) => entry.revision), [1]);
  } finally {
    if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret;
  }
});

test("disabled unlock cannot turn a judge into a global administrator", async () => {
  for (const judge of judges) {
    const response = await route("unlock", judge, {}).POST(
      request({ password: "anything" }),
    );
    assert.equal(response.status, 403);
    assert.equal(access.canManage(judge), false);
  }
});

test("detail and export scopes exclude other judges and numeric values for ordinary accounts", () => {
  const competitor = {
    id: crypto.randomUUID(),
    name: "One",
    division: "Individual Open",
    position: 1,
    status: "locked" as const,
    archived: false,
    dq: false,
  };
  const submission = (p: Profile): Submission => ({
    id: crypto.randomUUID(),
    competitor_id: competitor.id,
    user_id: p.id,
    slot: p.slot!,
    events: [
      {
        id: crypto.randomUUID(),
        trick: "T 3D",
        level: 2,
        features: ["T1"],
        at: new Date().toISOString(),
        value: 20.4,
      },
    ],
    performance: [5, 4, 3, 2, 1, 0],
    total: 20.4,
    finished: true,
    dq: false,
    version: 1,
    updated_at: new Date().toISOString(),
  });
  const records = [
    submission(judges[0]),
    submission(judges[1]),
    submission(alex),
  ];
  for (const judge of judges) {
    const visible = detailSubmissions(judge, records);
    const own = ownSubmissions(judge, records);
    assert.deepEqual(visible, own);
    const exported = detailExportRows(judge, records, [competitor]);
    assert.equal(exported.length, own.length);
    const serialized = JSON.stringify(exported);
    assert.doesNotMatch(serialized, /20\.4|"Total"|"Performance"|"value"/);
    for (const other of records.filter((s) => s.user_id !== judge.id))
      assert.ok(!serialized.includes(other.events[0].id));
    const personalExport = personalScoreExportRows(judge, records, [
      competitor,
    ]);
    assert.equal(personalExport.length, own.length);
    assert.ok(personalExport.every((row) => row.Total === "***"));
    assert.ok(!JSON.stringify(personalExport).includes("judge1"));
  }
  assert.equal(detailSubmissions(alex, records).length, 3);
  assert.equal(ownSubmissions(alex, records).length, 1);
  assert.equal(personalScoreExportRows(alex, records, [competitor]).length, 1);
  assert.equal(detailSubmissions(organizer, records).length, 3);
  assert.equal(
    personalScoreExportRows(organizer, records, [competitor]).length,
    0,
  );
});

test("a performance judge can see and export only their own performance values without Admin unlock", () => {
  const competitor = {
    id: crypto.randomUUID(), name: "One", division: "Individual Open", position: 1,
    status: "locked" as const, archived: false, dq: false,
  };
  const judge = judges[0];
  const ownPerformance: Submission = {
    id: crypto.randomUUID(), competitor_id: competitor.id, user_id: judge.id,
    slot: judge.slot!, scoring_type: "performance", events: [],
    performance: [5, 4, 3, 2, 1, 0], total: 15, finished: true, dq: false,
    version: 1, updated_at: new Date().toISOString(),
  };
  const otherPerformance = { ...ownPerformance, id: crypto.randomUUID(), user_id: judges[1].id, total: 30 };
  const visible = detailSubmissions(judge, [ownPerformance, otherPerformance]);
  assert.deepEqual(visible, [ownPerformance]);
  const detail = detailExportRows(judge, visible, [competitor]);
  assert.equal(detail[0].Total, 15);
  assert.equal(detail[0].Performance, "5 / 4 / 3 / 2 / 1 / 0");
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(otherPerformance.user_id));
  const personal = personalScoreExportRows(judge, visible, [competitor]);
  assert.equal(personal[0].Total, 15);
  assert.equal((personal[0] as Record<string, unknown>).Control, 5);
});

test("admin judge creates six-character-password judges and edits ordinary accounts without granting admin", async () => {
  for (const existing of [false, true]) {
    const writes: any[] = [];
    const target = judges[1];
    const client = {
      auth: {
        admin: {
          createUser: async (data: any) => {
            assert.equal(data.password, "123456");
            return { data: { user: { id: target.id } } };
          },
          updateUserById: async (id: string) => {
            assert.equal(id, target.id);
            return {};
          },
        },
      },
      from(table: string) {
        let updating = false;
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          neq: () => builder,
          maybeSingle: async () => ({ data: null }),
          single: async () => ({ data: updating ? { id: target.id } : target }),
          then: (done: (v: unknown) => unknown) =>
            Promise.resolve({ data: [] }).then(done),
          update: (data: unknown) => {
            updating = true;
            writes.push([table, data]);
            return builder;
          },
          insert: async (data: unknown) => {
            writes.push([table, data]);
            return {};
          },
        };
        return builder;
      },
    };
    const response = await route("manage", alex, client).POST(
      request({
        action: "user",
        data: {
          ...(existing ? { id: target.id } : {}),
          username: "testjudge",
          slot: 3,
          active: !existing,
          password: "123456",
          is_admin: true,
          role: "server_admin",
        },
      }),
    );
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const values = writes.find(([table]) => table === "profiles")[1];
    assert.equal(values.role, "judge");
    assert.notEqual(values.is_admin, true);
    assert.equal(values.active, !existing);
  }
});

test("administrator snapshot is sanitized for offline storage without losing Judge 1 pending work", async () => {
  const own: Submission = {
    id: crypto.randomUUID(),
    competitor_id: crypto.randomUUID(),
    user_id: alex.id,
    slot: 1,
    events: [
      {
        id: crypto.randomUUID(),
        trick: "T 3D",
        level: 1,
        features: [],
        at: new Date().toISOString(),
        value: 6,
      },
    ],
    performance: [0, 0, 0, 0, 0, 0],
    finished: false,
    dq: false,
    version: 1,
    updated_at: new Date().toISOString(),
    total: 6,
  };
  const workspace: LocalWorkspace = {
    snapshot: {
      profile: { ...alex, avatar_url: "https://signed.invalid/temporary" },
      competitors: [],
      submissions: [
        own,
        { ...own, id: crypto.randomUUID(), user_id: judges[0].id, slot: 2 },
      ],
      protected: true,
      profiles: [alex, organizer],
      audit: [{ secret: "audit-data" }],
      rankings: [],
      personal: [{ competitor_id: own.competitor_id, rank: 1, total: 6 }],
    },
    queue: [
      {
        id: crypto.randomUUID(),
        competitor_id: own.competitor_id,
        expected_version: 1,
        kind: "finish",
        payload: { finished: true },
      },
    ],
  };
  const cached = sanitizeWorkspace(workspace);
  assert.equal(cached.snapshot.protected, false);
  for (const key of ["profiles", "audit", "rankings"] as const)
    assert.equal(cached.snapshot[key], undefined);
  assert.equal(cached.snapshot.submissions.length, 1);
  assert.equal(cached.snapshot.submissions[0].total, undefined);
  assert.equal(cached.snapshot.submissions[0].events[0].value, undefined);
  assert.equal(cached.snapshot.personal![0].total, undefined);
  assert.deepEqual(cached.queue, workspace.queue);
  assert.equal(cached.snapshot.profile.id, alex.id);
  assert.equal(cached.snapshot.profile.slot, 1);
  assert.equal(cached.snapshot.profile.avatar_url, undefined);
  assert.equal(workspace.snapshot.submissions[0].total, 6);
  assert.equal(
    applyLocal(cached.snapshot, cached.queue[0]).submissions[0].finished,
    true,
  );
  let stored: LocalWorkspace | undefined;
  const storage = load("lib/local.ts", {
    idb: {
      openDB: async () => ({
        put: async (_store: string, value: LocalWorkspace, key: string) => {
          assert.equal(key, alex.id);
          stored = structuredClone(value);
        },
        get: async () => stored,
      }),
    },
  });
  await storage.writeLocal(alex.id, workspace);
  assert.deepEqual(stored, cached);
  assert.deepEqual(await storage.readLocal(alex.id), cached);
});

test("offline storage preserves only the signed-in performance judge's own rating values", () => {
  const judge: Profile = { ...judges[2], slot: 2 };
  const ownPerformance: Submission = {
    id: crypto.randomUUID(), competitor_id: crypto.randomUUID(), user_id: judge.id,
    slot: 2, scoring_type: "performance", events: [], performance: [4, 3, 2, 1, 0, 5],
    total: 15, finished: true, dq: false, version: 1, updated_at: new Date().toISOString(),
  };
  const cached = sanitizeWorkspace({
    snapshot: {
      profile: judge, competitors: [], submissions: [ownPerformance], protected: false,
      personal: [{ competitor_id: ownPerformance.competitor_id, rank: 1, total: 15 }],
    },
    queue: [],
  });
  assert.deepEqual(cached.snapshot.submissions[0].performance, ownPerformance.performance);
  assert.equal(cached.snapshot.submissions[0].total, 15);
  assert.equal(cached.snapshot.personal?.[0].total, 15);
});
