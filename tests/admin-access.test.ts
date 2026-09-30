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
import * as usernameUtils from "../lib/usernames";
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
  role: "organizer",
  active: true,
  is_admin: true,
};
const organizer: Profile = {
  ...alex,
  id: crypto.randomUUID(),
  username: "organizer",
  role: "organizer",
};
const judges = [2, 3, 4, 5].map((slot) => ({
  ...alex,
  id: crypto.randomUUID(),
  username: `judge${slot}`,
  role: slot <= 3 ? "technical_judge" as const : "performance_judge" as const,
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

test("organizer accounts manage the event while division assignments grant scoring", async () => {
  for (const p of [alex, organizer]) {
    assert.equal(access.canManage(p), true);
    assert.equal(access.canEditJudge(p), false);
  }
  assert.equal(access.isAssignedJudge(alex), true);
  assert.equal(access.isAssignedJudge(organizer), true);
  assert.equal(access.profileCanScoreType(organizer, "technical"), true);
  assert.equal(access.profileCanScoreType(organizer, "performance"), true);
  assert.equal(access.profileCanScoreType({ ...judges[0], role: "technical_judge" }, "performance"), false);
  const serverJudge: Profile = {
    ...alex,
    role: "server_admin",
    is_admin: false,
  };
  assert.equal(access.canManage(serverJudge), true);
  assert.equal(access.isAssignedJudge(serverJudge), true);
  for (const p of judges) {
    assert.equal(access.canManage(p), false);
    assert.equal(access.canEditJudge(p), true);
  }
  assert.equal(access.canManage({ ...alex, role: "technical_judge", is_admin: undefined }), false);
  assert.equal(access.canManage({ ...alex, active: false }), false);
});

test("Admin score-view password is checked server-side for every signed-in account", async () => {
  const previous = process.env.ADMIN_VIEW_PASSWORD;
  const previousSigningSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.ADMIN_VIEW_PASSWORD = "ndladm";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-signing-secret-0123456789abcdef";
  try {
    for (const profile of [...judges, alex, organizer]) {
      const tables: string[] = [];
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      const handlers = route("verify-admin", profile, {
        from: (table: string) => {
          tables.push(table);
          return query;
        },
      });
      assert.equal(
        (await handlers.POST(request({ password: "wrong" }))).status,
        401,
      );
      tables.length = 0;
      const authorized = await handlers.POST(request({ password: "ndladm" }));
      assert.equal(authorized.status, 200);
      assert.deepEqual(tables, ["audit"], "Admin unlock does not query the competitor roster");
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

test("Admin unlock authentication failures are explicit JSON 401 responses", async () => {
  const handlers = load("app/api/verify-admin/route.ts", {
    "@/lib/server": {
      ...server,
      identity: async () => { throw new Error("Sign in required"); },
    },
  });
  const response = await handlers.POST(request({ password: "ndladm" }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "Sign in required" });
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

test("sync leaves division authorization to the server-side assignment check", async () => {
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
    scoring_window_revision: crypto.randomUUID(),
    scoring_window_token: crypto.randomUUID(),
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
  assert.equal(calls[0][1].p_window_revision, body.scoring_window_revision);
  assert.equal(calls[0][1].p_window_token, body.scoring_window_token);
  const legacyOffline = { ...body } as Record<string, unknown>;
  delete legacyOffline.scoring_window_token;
  const needsReconciliation = await route("sync", alex, client).POST(request(legacyOffline));
  assert.equal(needsReconciliation.status, 409);
  assert.match((await needsReconciliation.json()).error, /remains saved locally.*reconcile/i);
  assert.equal(calls.length, 1, "a queued action without server-issued window proof never reaches the scoring RPC");
  assert.equal((await route("sync", organizer, client).POST(request(body))).status, 200);
  assert.equal(calls.length, 2);
  const reopenRequest = {
    ...body,
    kind: "finish",
    payload: { finished: false },
  };
  assert.equal((await route("sync", alex, client).POST(request(reopenRequest))).status, 400);
  assert.equal(calls.length, 2, "judge sync cannot reopen a submitted score");
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

test("alexandertai remains protected from account role or identity changes", async () => {
  for (const target of [alex]) {
    const builder: any = {
      selected: "",
      filter: "",
      select: (columns: string) => { builder.selected = columns; return builder; },
      eq: (column: string) => { builder.filter = column; return builder; },
      neq: () => builder,
      maybeSingle: async () => ({ data: builder.filter === "id" ? target : null }),
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
        action: "update_user",
        data: {
          id: target.id,
          username: "renamed",
          name: "Renamed account",
          role: "technical_judge",
          password: "123456",
        },
      }),
    );
    assert.equal(response.status, 403);
    assert.match(
      (await response.json()).error,
      /alexandertai is protected from Server Access Control account changes/,
    );
  }
});

test("the alexandertai and organizer accounts cannot be edited or deleted in Server Access Control", async () => {
  for (const username of ["alexandertai", "organizer"]) {
    const target = { ...alex, id: crypto.randomUUID(), username, name: username, role: "organizer" as const };
    let profileWrites = 0;
    let authDeletes = 0;
    const client = {
      from: (table: string) => {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: table === "profiles" ? target : null, error: null }),
          update: () => { profileWrites += 1; return builder; },
          single: async () => ({ data: target, error: null }),
        };
        return builder;
      },
      auth: { admin: {
        updateUserById: async () => { profileWrites += 1; return { error: null }; },
        deleteUser: async () => { authDeletes += 1; return { error: null }; },
      } },
    };
    const edited = await route("manage", alex, client).POST(request({
      action: "update_user", data: { id: target.id, name: "Changed", username, role: "organizer" },
    }));
    assert.equal(edited.status, 403);
    assert.match((await edited.json()).error, /protected from Server Access Control/i);
    const deleted = await route("manage", alex, client).POST(request({
      action: "remove_user", data: { id: target.id, confirmation: "DELETE JUDGE" },
    }));
    assert.equal(deleted.status, 403);
    assert.match((await deleted.json()).error, /protected Organizer account/i);
    assert.equal(profileWrites, 0);
    assert.equal(authDeletes, 0);
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
  const scoringProfiles = [alex, ...judges];
  const submissions = scoringProfiles.map((p, index) => ({
    id: crypto.randomUUID(),
    competitor_id: competitor.id,
    user_id: p.id,
    slot: index + 1,
    scoring_type: p.role === "performance_judge" ? "performance" : "technical",
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
                ? scoringProfiles.flatMap((row, index) => {
                    const scoring_type = row.role === "performance_judge" ? "performance" : "technical";
                    return [
                      { division: "Individual Open", slot: index + 1, user_id: row.id, scoring_type },
                      { division: "Team Division", slot: index + 1, user_id: row.id, scoring_type },
                    ];
                  })
              : table === "competitor_judges"
                ? scoringProfiles.map((row, index) => ({
                    competitor_id: competitor.id,
                    user_id: row.id,
                    scoring_type: row.role === "performance_judge" ? "performance" : "technical",
                    roster_order: index + 1,
                    display_name: row.name,
                    role_snapshot: row.role,
                    expected: true,
                  }))
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
      rpc: async (name: string, args: Record<string, string>) => name === "issue_scoring_window"
        ? { data: args.p_user === p.id ? {
            competitor_id: competitor.id,
            revision: crypto.randomUUID(),
            token: crypto.randomUUID(),
            opened_at: new Date().toISOString(),
          } : null, error: null }
        : { data: null, error: null },
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
      assert.equal(submission.total, undefined);
      assert.deepEqual(submission.performance, []);
      assert.equal(submission.events[0].value, undefined);
    }
    assert.ok(hiddenBody.personal.every((entry: any) => entry.total === undefined));
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
    const unlockedButHidden = await route("state", p, client).GET(
      new Request("http://localhost/api/state", {
        headers: { "x-hidc-admin-unlock": unlockToken },
      }),
    );
    assert.equal(unlockedButHidden.status, 200);
    const stillHidden = await unlockedButHidden.json();
    assert.equal(stillHidden.pointAccess, false, "Admin unlock alone must not reveal points");
    for (const saved of stillHidden.submissions) {
      assert.equal(saved.total, undefined);
      assert.deepEqual(saved.performance, []);
      assert.equal(saved.events[0].value, undefined);
    }
    const unlocked = await route("state", p, client).GET(
      new Request("http://localhost/api/state", {
        headers: { "x-hidc-admin-unlock": unlockToken, "x-hidc-show-points": "1" },
      }),
    );
    assert.equal(unlocked.status, 200);
    const visibleBody = await unlocked.json();
    assert.equal(visibleBody.pointAccess, true);
    for (const saved of visibleBody.submissions.filter((row: any) => row.scoring_type === "technical")) {
      assert.equal(saved.total, 9);
      assert.equal(saved.events[0].value, 9);
    }
    const ownExport = personalScoreExportRows(p, visibleBody.submissions, [competitor], true);
    if (p.role === "technical_judge" && ownExport.length > 0) {
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
      assert.equal(visibleBody.submissions[0].total, p.role === "technical_judge" ? 9 : 30);
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
      scoring_type: "technical",
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
    const unlockOnly = await handlers.GET(new Request("http://localhost/api/scoring-configuration", {
      headers: { "x-hidc-admin-unlock": createAdminUnlockToken(alex.id) },
    }));
    assert.equal(unlockOnly.status, 403, "configuration values require Show Points as well as Admin unlock");

    for (const account of [alex, organizer]) {
      const token = createAdminUnlockToken(account.id);
      const response = await route("scoring-configuration", account, client).GET(
        new Request("http://localhost/api/scoring-configuration", {
          headers: { "x-hidc-admin-unlock": token, "x-hidc-show-points": "1" },
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
          headers: { "x-hidc-admin-unlock": token, "x-hidc-show-points": "1" },
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
        headers: { "content-type": "application/json", "x-hidc-admin-unlock": token, "x-hidc-show-points": "1" },
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
        headers: { "content-type": "application/json", "x-hidc-admin-unlock": token, "x-hidc-show-points": "1" },
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
        headers: { "content-type": "application/json", "x-hidc-admin-unlock": token, "x-hidc-show-points": "1" },
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
        headers: { "x-hidc-admin-unlock": token, "x-hidc-show-points": "1" },
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

test("performance points stay masked until Admin unlock and Show Points are both active", () => {
  const competitor = {
    id: crypto.randomUUID(), name: "One", division: "Individual Open", position: 1,
    status: "locked" as const, archived: false, dq: false,
  };
  const judge = judges[2];
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
  assert.equal(detail[0].Total, undefined);
  assert.equal(detail[0].Performance, undefined);
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(otherPerformance.user_id));
  const personal = personalScoreExportRows(judge, visible, [competitor]);
  assert.equal(personal[0].Total, "***");
  assert.equal((personal[0] as Record<string, unknown>).Control, "***");
  const revealed = personalScoreExportRows(judge, visible, [competitor], true);
  assert.equal(revealed[0].Total, 15);
  assert.equal((revealed[0] as Record<string, unknown>).Control, 5);
});

test("organizers create each supported role as a new account without numbered slots", async () => {
  for (const role of ["technical_judge", "performance_judge", "organizer"] as const) {
    const writes: any[] = [];
    const targetId = crypto.randomUUID();
    const client = {
      auth: { admin: { createUser: async (input: any) => {
        assert.equal(input.password, "123456");
        return { data: { user: { id: targetId } } };
      } } },
      from(table: string) {
        let inserted: any;
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          neq: () => builder,
          maybeSingle: async () => ({ data: null }),
          single: async () => ({ data: { id: targetId, role } }),
          insert: async (data: unknown) => {
            inserted = data;
            writes.push([table, data]);
            return builder;
          },
          then: (done: (value: unknown) => unknown) => Promise.resolve({ error: null, data: inserted }).then(done),
        };
        return builder;
      },
    };
    const response = await route("manage", alex, client).POST(request({
      action: "create_user",
      data: { name: "New Judge", username: `new_${role}`, role, password: "123456" },
    }));
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const values = writes.find(([table]) => table === "profiles")[1];
    assert.equal(values.role, role);
    assert.equal(values.id, targetId);
    assert.notEqual(values.id, alex.id);
    assert.equal(values.slot, undefined);
    assert.equal(values.is_admin, role === "organizer");
  }
});

test("creating an account rejects an accidental profile id instead of editing the signed-in organizer", async () => {
  let authCreates = 0;
  let profileInserts = 0;
  let authUpdates = 0;
  const client = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: async () => { if (table === "profiles") profileInserts += 1; return { error: null }; },
    }),
    auth: { admin: {
      createUser: async () => { authCreates += 1; return { data: { user: { id: crypto.randomUUID() } } }; },
      updateUserById: async () => { authUpdates += 1; return { error: null }; },
    } },
  };
  const response = await route("manage", alex, client).POST(request({
    action: "create_user",
    data: { id: alex.id, name: "New Judge", username: "new_judge", role: "technical_judge", password: "123456" },
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Unrecognized key.*id/i);
  assert.equal(authCreates, 0);
  assert.equal(profileInserts, 0);
  assert.equal(authUpdates, 0);
});

test("account creation validates reserved, duplicate, malformed, and weak credentials before profile writes", async () => {
  let authCreates = 0;
  let profileInserts = 0;
  const existing = { id: crypto.randomUUID(), username: "existing_judge" };
  const client = {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: (_column: string, value: string) => { builder.username = value; return builder; },
        maybeSingle: async () => ({ data: builder.username === existing.username ? existing : null, error: null }),
        insert: async () => { if (table === "profiles") profileInserts += 1; return { error: null }; },
      };
      return builder;
    },
    auth: { admin: { createUser: async () => { authCreates += 1; return { data: { user: { id: crypto.randomUUID() } } }; } } },
  };
  const cases = [
    { username: "ORGANIZER", password: "strong-test-pass", status: 409, message: /reserved for a protected account/i },
    { username: "EXISTING_JUDGE", password: "strong-test-pass", status: 409, message: /username already exists/i },
    { username: "xy", password: "strong-test-pass", status: 400, message: /3–32 letters/i },
    { username: "valid_judge", password: "123", status: 400, message: /at least 6 characters/i },
  ];
  for (const item of cases) {
    const response = await route("manage", alex, client).POST(request({
      action: "create_user",
      data: { name: "New Judge", username: item.username, role: "technical_judge", password: item.password },
    }));
    assert.equal(response.status, item.status);
    assert.match((await response.json()).error, item.message);
  }
  assert.equal(authCreates, 0);
  assert.equal(profileInserts, 0);
});

test("Auth password-policy failures are clear and profile failures remove the new Auth identity", async () => {
  let authDeletes = 0;
  let authBans = 0;
  const passwordRejected = await route("manage", alex, {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    auth: { admin: { createUser: async () => ({ error: { code: "weak_password", message: "Password should be stronger" } }) } },
  }).POST(request({ action: "create_user", data: { name: "Weak Test", username: "weak_test", role: "technical_judge", password: "123456" } }));
  assert.equal(passwordRejected.status, 400);
  assert.match((await passwordRejected.json()).error, /Password is weak or invalid/i);

  const id = crypto.randomUUID();
  const profileRejected = await route("manage", alex, {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async () => table === "profiles" ? { error: { code: "XX000", message: "profile database unavailable" } } : { error: null },
      };
      return builder;
    },
    auth: { admin: {
      createUser: async () => ({ data: { user: { id } } }),
      deleteUser: async (deletedId: string) => { assert.equal(deletedId, id); authDeletes += 1; return { error: null }; },
      updateUserById: async () => { authBans += 1; return { error: null }; },
    } },
  }).POST(request({ action: "create_user", data: { name: "Profile Failure", username: "profile_failure", role: "technical_judge", password: "strong-test-pass" } }));
  assert.equal(profileRejected.status, 500);
  assert.match((await profileRejected.json()).error, /temporary Auth account was removed/i);
  assert.equal(authDeletes, 1);
  assert.equal(authBans, 0);

  let fallbackBans = 0;
  const unremovableProfileRejected = await route("manage", alex, {
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async () => table === "profiles" ? { error: { code: "XX000", message: "database unavailable" } } : { error: null },
      };
      return builder;
    },
    auth: { admin: {
      createUser: async () => ({ data: { user: { id } } }),
      deleteUser: async () => ({ error: { message: "temporary auth failure" } }),
      updateUserById: async (targetId: string, values: { ban_duration: string }) => {
        assert.equal(targetId, id);
        assert.equal(values.ban_duration, "876000h");
        fallbackBans += 1;
        return { error: null };
      },
    } },
  }).POST(request({ action: "create_user", data: { name: "Profile Failure", username: "profile_failure", role: "technical_judge", password: "strong-test-pass" } }));
  assert.equal(unremovableProfileRejected.status, 500);
  assert.match((await unremovableProfileRejected.json()).error, /orphan Auth account was disabled/i);
  assert.equal(fallbackBans, 1);
});

test("new accounts receive separate Auth/profile IDs and can sign in by their new username", async () => {
  const authUsers = new Map<string, { id: string; email: string; password: string }>();
  const profiles: Array<Record<string, unknown>> = [structuredClone(alex)];
  const auditRows: unknown[] = [];
  let protectedAccountUpdates = 0;
  const client = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder: any = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        maybeSingle: async () => ({ data: profiles.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }),
        single: async () => ({ data: profiles.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (table === "profiles") profiles.push(structuredClone(row));
          else if (table === "audit") auditRows.push(structuredClone(row));
          return { data: row, error: null };
        },
      };
      return builder;
    },
    auth: {
      admin: {
        createUser: async (input: { email: string; password: string }) => {
          const id = crypto.randomUUID();
          authUsers.set(id, { id, email: input.email, password: input.password });
          return { data: { user: { id, email: input.email } }, error: null };
        },
        getUserById: async (id: string) => ({ data: { user: authUsers.get(id) ?? null }, error: null }),
        updateUserById: async (id: string) => {
          if (id === alex.id) protectedAccountUpdates += 1;
          return { error: null };
        },
        deleteUser: async (id: string) => { authUsers.delete(id); return { error: null }; },
      },
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        const user = [...authUsers.values()].find((candidate) => candidate.email === email && candidate.password === password);
        return user
          ? { data: { session: { access_token: `access:${user.id}`, refresh_token: `refresh:${user.id}` } }, error: null }
          : { data: { session: null }, error: { message: "Invalid login" } };
      },
    },
  };
  const originalAlex = structuredClone(alex);
  const created: Array<{ id: string; username: string; password: string; role: string }> = [];
  for (const role of ["technical_judge", "performance_judge", "organizer"] as const) {
    const username = `new_${role}`;
    const password = "Strong-test-password-46";
    const response = await route("manage", alex, client).POST(request({
      action: "create_user", data: { name: `New ${role}`, username, role, password },
    }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json();
    const account = body.createdAccount;
    assert.ok(account?.id);
    assert.notEqual(account.id, alex.id);
    assert.equal(account.username, username);
    assert.equal(account.role, role);
    const profile = profiles.find((row) => row.id === account.id);
    assert.equal(profile?.username, username);
    assert.equal(profile?.role, role);
    assert.equal((authUsers.get(account.id)?.email ?? "").startsWith(`${username}.`), true);
    created.push({ id: account.id, username, password, role });
  }
  assert.equal(new Set(created.map((account) => account.id)).size, 3);
  assert.deepEqual(profiles.find((row) => row.id === alex.id), originalAlex);
  assert.equal(protectedAccountUpdates, 0);
  assert.equal(auditRows.length, 3);

  const loginRoute = load("app/api/login/route.ts", {
    "@/lib/server": { db: () => client },
    "@/lib/usernames": usernameUtils,
  });
  for (const account of created) {
    const response = await loginRoute.POST(request({ username: account.username.toUpperCase(), password: account.password }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.ok((await response.json()).access_token.includes(account.id));
  }
});

test("organizer permanently deletes accounts with or without score history through the preservation trigger", async () => {
  for (const scoreCount of [0, 3]) {
    let authDeletions = 0;
    let prepareCalled = false;
    let cancelled = false;
    const targetId = crypto.randomUUID();
    const client = {
      from: (table: string) => {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: table === "profiles"
              ? { id: targetId, username: "formerjudge", name: "Former Judge", role: "technical_judge", active: true, avatar_path: null }
              : null,
            error: null,
          }),
          then: (done: (value: unknown) => unknown) =>
            Promise.resolve({ count: scoreCount, error: null }).then(done),
        };
        return builder;
      },
      rpc: async (name: string, args: Record<string, string>) => {
        assert.equal(args.p_actor, alex.id);
        assert.equal(args.p_target, targetId);
        if (name === "prepare_judge_deletion") {
          prepareCalled = true;
          return { data: { avatar_path: null }, error: null };
        }
        if (name === "cancel_judge_deletion") cancelled = true;
        return { data: null, error: null };
      },
      auth: { admin: { deleteUser: async (id: string) => {
        assert.equal(id, targetId);
        authDeletions += 1;
        return { error: null };
      } } },
    };
    const response = await route("manage", alex, client).POST(request({ action: "remove_user", data: { id: targetId, confirmation: "formerjudge" } }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(prepareCalled, true);
    assert.equal(authDeletions, 1, "an account with scores is also deleted rather than archived");
    assert.equal(cancelled, false);
    assert.deepEqual(await response.json(), { ok: true, permanentlyDeleted: true, submittedScoresPreserved: scoreCount > 0 });
  }

  const noDatabaseAccess = { from: () => { throw new Error("Organizer authorization should fail first"); } };
  const denied = await route("manage", judges[0], noDatabaseAccess).POST(request({ action: "remove_user", data: { id: crypto.randomUUID(), confirmation: "DELETE JUDGE" } }));
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /Organizer access required/);
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
  assert.equal(cached.snapshot.profile.slot, undefined);
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

test("offline storage masks saved points until Admin unlock and Show Points are both active", () => {
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
  assert.deepEqual(cached.snapshot.submissions[0].performance, []);
  assert.equal(cached.snapshot.submissions[0].total, undefined);
  assert.equal(cached.snapshot.personal?.[0].total, undefined);
});
