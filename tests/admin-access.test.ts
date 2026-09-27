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
  sanitizeWorkspace,
  applyLocal,
  type LocalWorkspace,
} from "../lib/local";
import type { Profile, Submission } from "../lib/model";
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
  process.env.ADMIN_VIEW_PASSWORD = "ndladm";
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
      assert.equal(
        (await handlers.POST(request({ password: "ndladm" }))).status,
        200,
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

test("Judge 1 submits technical scores with unchanged attribution; backup organizer cannot score", async () => {
  const calls: any[] = [];
  const client = {
    rpc: async (...args: any[]) => {
      calls.push(args);
      return { data: { ok: true } };
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
      from: (table: string) => ({
        insert: async (data: unknown) => {
          calls.push([table, data]);
          return {};
        },
      }),
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

test("state endpoint returns only own numeric scores to judges and global data only to administrators", async () => {
  const competitor = {
    id: crypto.randomUUID(),
    name: "Test",
    division: "Individual Open",
    position: 1,
    status: "active",
    archived: false,
    dq: false,
  };
  const profiles = [alex, ...judges, organizer];
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
  for (const p of [...profiles, serverJudge]) {
    const client = {
      from(table: string) {
        let data: any[] =
          table === "competitors"
            ? [competitor]
            : table === "submissions"
              ? [...submissions]
              : table === "profiles"
                ? profiles.map((row) => ({
                    ...row,
                    avatar_path: `${row.id}/private-avatar.png`,
                  }))
                : table === "audit"
                  ? [{ action: "test" }]
                  : [{ name: "Individual Open" }];
        const builder: any = {
          select: () => builder,
          order: () => builder,
          limit: () => builder,
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
    const body = await response.json();
    if (access.isAdministrator(p)) {
      assert.equal(body.protected, true);
      assert.equal(body.submissions.length, 5);
      assert.equal(body.submissions[0].total, 6);
      assert.equal(body.rankings.length, 1);
      assert.equal(body.audit.length, 1);
      assert.equal(body.profiles.length, 6);
      for (const metadata of body.profiles) {
        assert.equal(metadata.avatar_path, undefined);
        assert.equal(metadata.email, undefined);
        assert.equal(metadata.password, undefined);
        assert.equal(metadata.password_hash, undefined);
        assert.match(metadata.avatar_url, /^https:\/\/signed\.invalid\//);
      }
    } else {
      assert.equal(body.protected, false);
      assert.equal(body.submissions.length, 1);
      assert.equal(body.submissions[0].user_id, p.id);
      assert.equal(body.submissions[0].total, p.slot! <= 3 ? 6 : 30);
      assert.equal(body.submissions[0].events[0].value, 6);
      assert.equal(body.rankings, undefined);
      assert.equal(body.audit, undefined);
      assert.equal(body.profiles, undefined);
      assert.equal(body.profile.avatar_path, undefined);
      assert.equal(body.profile.password, undefined);
      assert.equal(body.profile.password_hash, undefined);
    }
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
    assert.ok(personalExport.every((row) => row.Total === 20.4));
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
