import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { validatedImageType } from "../lib/profile-image";
import { profilePasswordError } from "../lib/password-validation";
import type { Profile } from "../lib/model";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

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
  new Function("require", "module", "exports", source)(require, module, module.exports);
  return module.exports;
}

const judge: Profile = {
  id: crypto.randomUUID(), name: "Judge Three", username: "judge3", role: "judge", slot: 3, active: true,
};
function profileRoute(options: {
  wrongPassword?: boolean;
  duplicate?: boolean;
  actor?: Profile;
  identityError?: string;
  authUpdateError?: boolean;
} = {}) {
  const actor = options.actor ?? judge;
  const updates: unknown[] = [];
  const updateTargets: string[] = [];
  const authUpdates: unknown[] = [];
  let storedPassword = options.wrongPassword ? "other-password" : "current-secret";
  const passwordAuth = {
    signInWithPassword: async ({ password }: { password: string }) => ({
      error: password === storedPassword ? null : new Error("invalid"),
    }),
  };
  const client = {
    auth: { admin: {
      getUserById: async () => ({ data: { user: { email: "judge3.random@hidc.internal" } }, error: null }),
      updateUserById: async (_id: string, value: unknown) => {
        authUpdates.push(value);
        if (options.authUpdateError) return { error: new Error("update failed") };
        if (typeof value === "object" && value && "password" in value)
          storedPassword = String((value as { password: string }).password);
        return { error: null };
      },
    } },
    from: (_table: string) => {
      const query: any = {
        select: () => query,
        eq: (_field: string, value: string) => { if (query.updateValue) updateTargets.push(value); return query; },
        neq: () => query,
        maybeSingle: async () => ({ data: options.duplicate ? { id: crypto.randomUUID() } : null, error: null }),
        update: (value: unknown) => { updates.push(value); query.updateValue = value; return query; },
      };
      return query;
    },
  };
  const server = {
    identity: async () => {
      if (options.identityError) throw new Error(options.identityError);
      return { profile: actor, client };
    },
    failure: (error: unknown) => Response.json({ error: String(error) }, { status: 400 }),
  };
  const handlers = load("app/api/profile/route.ts", {
    "@/lib/server": server,
    "@/lib/usernames": require("../lib/usernames"),
    "@supabase/supabase-js": { createClient: () => ({ auth: passwordAuth }) },
  });
  return {
    handlers,
    updates,
    updateTargets,
    authUpdates,
    signInWithPassword: passwordAuth.signInWithPassword,
  };
}
const patchRequest = (value: unknown) => new Request("http://localhost/api/profile", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

test("profile updates verify current password and change only self profile plus private synthetic mapping", async () => {
  const fixture = profileRoute();
  const { handlers, updates, authUpdates } = fixture;
  const response = await handlers.PATCH(patchRequest({
    name: "Judge Three Updated", username: "judge3new", currentPassword: "current-secret", newPassword: "new-secret-123",
  }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.match(response.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(updates, [{ name: "Judge Three Updated", username: "judge3new" }]);
  assert.equal(authUpdates.length, 1);
  const mapping = authUpdates[0] as { email: string; password: string; email_confirm: boolean };
  assert.match(mapping.email, /^judge3new\.[^@]+@hidc\.internal$/);
  assert.equal(mapping.password, "new-secret-123");
  assert.equal(mapping.email_confirm, true);
  assert.equal((await fixture.signInWithPassword({ password: "new-secret-123" })).error, null);
  assert.ok((await fixture.signInWithPassword({ password: "current-secret" })).error);
});

test("profile endpoint rejects attempts to edit IDs, role, slot, or administrator state", async () => {
  const { handlers, updates } = profileRoute();
  const response = await handlers.PATCH(patchRequest({ name: "Impersonate", username: "judge3", id: crypto.randomUUID(), role: "server_admin", slot: 1, is_admin: true }));
  assert.equal(response.status, 400);
  assert.equal(updates.length, 0);
});

test("profile endpoint rejects duplicate usernames and incorrect current password", async () => {
  const duplicate = profileRoute({ duplicate: true });
  const collision = await duplicate.handlers.PATCH(patchRequest({ name: judge.name, username: "taken", currentPassword: "current-secret" }));
  assert.equal(collision.status, 409, JSON.stringify(await collision.clone().json()));
  assert.equal(duplicate.authUpdates.length, 0);

  const incorrect = profileRoute({ wrongPassword: true });
  const denied = await incorrect.handlers.PATCH(patchRequest({ name: judge.name, username: "different", currentPassword: "wrong" }));
  assert.equal(denied.status, 401);
  assert.equal(incorrect.updates.length, 0);

  const missingCurrentPassword = profileRoute();
  const missing = await missingCurrentPassword.handlers.PATCH(patchRequest({ name: judge.name, username: "different" }));
  assert.equal(missing.status, 400);
  assert.match(missing.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.ok((await missing.json()).error);
  assert.equal(missingCurrentPassword.authUpdates.length, 0);
});

test("profile endpoint returns JSON for validation, unauthorized, server-error, and no-op paths", async () => {
  const noOp = profileRoute();
  const unchanged = await noOp.handlers.PATCH(patchRequest({ name: judge.name, username: judge.username }));
  assert.equal(unchanged.status, 200);
  assert.match(unchanged.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await unchanged.json(), { ok: true });

  const unsupported = await noOp.handlers.POST(new Request("http://localhost/api/profile", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: judge.name, username: judge.username }),
  }));
  assert.equal(unsupported.status, 405);
  assert.match(unsupported.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await unsupported.json(), { error: "Method not allowed." });

  const invalid = await noOp.handlers.PATCH(new Request("http://localhost/api/profile", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{",
  }));
  assert.equal(invalid.status, 400);
  assert.match(invalid.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.ok((await invalid.json()).error);

  const unauthorized = profileRoute({ identityError: "Sign in required" });
  const denied = await unauthorized.handlers.PATCH(patchRequest({ name: judge.name, username: judge.username }));
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.ok((await denied.json()).error);

  const serverError = profileRoute({ authUpdateError: true });
  const failed = await serverError.handlers.PATCH(patchRequest({
    name: judge.name, username: judge.username, currentPassword: "current-secret", newPassword: "new-pass-123",
  }));
  assert.equal(failed.status, 500);
  assert.match(failed.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.ok((await failed.json()).error);
});

test("password confirmation and length validation report mismatch and invalid values", () => {
  assert.equal(profilePasswordError("", ""), null);
  assert.equal(profilePasswordError("", "something"), "The new passwords do not match.");
  assert.equal(profilePasswordError("new-password", "different"), "The new passwords do not match.");
  assert.equal(profilePasswordError("short", "short"), "New password must be between 6 and 256 characters.");
  assert.equal(profilePasswordError("valid-123", "valid-123"), null);
  assert.equal(profilePasswordError("x".repeat(257), "x".repeat(257)), "New password must be between 6 and 256 characters.");
});

test("profile API rejects empty or too-short password values", async () => {
  for (const newPassword of ["", "short"]) {
    const fixture = profileRoute();
    const response = await fixture.handlers.PATCH(patchRequest({
      name: judge.name,
      username: judge.username,
      currentPassword: "current-secret",
      newPassword,
    }));
    assert.equal(response.status, 400);
    assert.match(response.headers.get("Content-Type") ?? "", /^application\/json\b/i);
    assert.ok((await response.json()).error);
    assert.equal(fixture.authUpdates.length, 0);
  }
});

test("profile endpoint never returns password, hash, or hidden auth email", async () => {
  const { handlers } = profileRoute();
  const response = await handlers.PATCH(patchRequest({ name: judge.name, username: judge.username }));
  const body = JSON.stringify(await response.json());
  assert.equal(body, '{"ok":true}');
  assert.doesNotMatch(body, /password|hash|email|hidc\.internal/i);
});

test("ordinary judge, alexandertai, and organizer can each edit only their own display name", async () => {
  const adminJudge: Profile = { ...judge, id: crypto.randomUUID(), name: "Alex", username: "alexandertai", slot: 1, is_admin: true };
  const organizer: Profile = { ...judge, id: crypto.randomUUID(), name: "Organizer", username: "organizer", role: "server_admin", slot: null };
  for (const actor of [judge, adminJudge, organizer]) {
    const fixture = profileRoute({ actor });
    const response = await fixture.handlers.PATCH(patchRequest({ name: `${actor.name} Updated`, username: actor.username }));
    assert.equal(response.status, 200);
    assert.deepEqual(fixture.updateTargets, [actor.id]);
    assert.deepEqual(fixture.updates, [{ name: `${actor.name} Updated` }]);
  }
});

test("avatar validator accepts only matching JPEG, PNG, or WebP signatures", () => {
  assert.equal(validatedImageType("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))?.extension, "jpg");
  assert.equal(validatedImageType("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.extension, "png");
  assert.equal(validatedImageType("image/webp", Uint8Array.from([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]))?.extension, "webp");
  assert.equal(validatedImageType("image/jpeg", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(validatedImageType("image/svg+xml", new Uint8Array([1, 2, 3])), null);
});

test("avatar upload enforces size/type and binds storage/profile writes to the signed-in ID", async () => {
  const owner = judge.id;
  const other = crypto.randomUUID();
  const writes: { path: string; owner: string; bytes: Uint8Array }[] = [];
  const profileWriteOwners: string[] = [];
  const client = {
    from: (_table: string) => {
      const query: any = {
        select: () => query,
        eq: (_key: string, value: string) => { query.owner = value; if (query.value) profileWriteOwners.push(value); return query; },
        single: async () => ({ data: { avatar_path: null }, error: null }),
        update: (value: Record<string, unknown>) => { query.value = value; return query; },
      };
      return query;
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array, _options: unknown) => { writes.push({ path, bytes, owner: "" }); return { error: null }; },
        remove: async () => ({ error: null }),
      }),
    },
  };
  const server = {
    identity: async () => ({ profile: judge, client }),
    failure: (error: unknown) => Response.json({ error: String(error) }, { status: 400 }),
  };
  const handlers = load("app/api/profile/avatar/route.ts", {
    "@/lib/server": server,
    "@/lib/profile-image": require("../lib/profile-image"),
  });
  const post = async (file: File) => {
    const form = new FormData();
    form.set("avatar", file);
    form.set("profile_id", other); // Must be ignored; the actor ID comes from auth.
    return handlers.POST(new Request("http://localhost/api/profile/avatar", { method: "POST", body: form }));
  };
  const fake = await post(new File([new Uint8Array([1, 2, 3])], "fake.jpg", { type: "image/jpeg" }));
  assert.equal(fake.status, 415);
  const tooLarge = await post(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
  assert.equal(tooLarge.status, 413);
  assert.equal(writes.length, 0);
  const valid = await post(new File([Uint8Array.from([0xff, 0xd8, 0xff, 0x00])], "avatar.jpg", { type: "image/jpeg" }));
  assert.equal(valid.status, 200);
  assert.match(writes[0].path, new RegExp(`^${owner}/[0-9a-f-]+\\.jpg$`));
  assert.deepEqual(profileWriteOwners, [owner]);
  assert.doesNotMatch(JSON.stringify(await valid.json()), /profile_id|avatar_path|password|hidc\.internal/);
});
