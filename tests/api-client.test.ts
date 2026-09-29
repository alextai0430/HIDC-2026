import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

function loadApi(auth: {
  getSession: () => Promise<any>;
  refreshSession: () => Promise<any>;
} = {
  getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
  refreshSession: async () => ({ data: { session: null }, error: new Error("No refresh session") }),
}) {
  const filename = resolve("lib/supabase.ts");
  const nativeRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (name: string) => name === "@supabase/supabase-js"
    ? { createClient: () => ({ auth }) }
    : nativeRequire(name);
  new Function("require", "module", "exports", source)(require, module, module.exports);
  return module.exports as { api: (path: string, body?: unknown, options?: { method?: string }) => Promise<unknown> };
}

test("api helper sends profile updates as PATCH and accepts an empty successful response", async () => {
  const { api } = loadApi();
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    request = init;
    return new Response(null, { status: 204 });
  };
  try {
    const result = await api("profile", { name: "Judge", username: "judge3" }, { method: "PATCH" });
    assert.deepEqual(result, {});
    assert.equal(request?.method, "PATCH");
    assert.equal(request?.body, JSON.stringify({ name: "Judge", username: "judge3" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api helper returns a useful status error for an empty or malformed failure body", async () => {
  const { api } = loadApi();
  const originalFetch = globalThis.fetch;
  try {
    for (const response of [new Response(null, { status: 405 }), new Response("Method Not Allowed", { status: 405 })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(api("profile", { name: "Judge", username: "judge3" }, { method: "PATCH" }), /Request failed \(HTTP 405\)/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api helper preserves a JSON error message", async () => {
  const { api } = loadApi();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: "Current password is incorrect." }, { status: 401 });
  try {
    await assert.rejects(api("profile", {}, { method: "PATCH" }), /Current password is incorrect\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api helper refreshes an expired session once and retries identity failures", async () => {
  let refreshes = 0;
  const { api } = loadApi({
    getSession: async () => ({ data: { session: { access_token: "expired-token" } } }),
    refreshSession: async () => {
      refreshes += 1;
      return { data: { session: { access_token: "refreshed-token" } }, error: null };
    },
  });
  const originalFetch = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get("Authorization") ?? "";
    tokens.push(token);
    return token === "Bearer expired-token"
      ? Response.json({ error: "Sign in required" }, { status: 401 })
      : Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await api("verify-admin", { password: "test" }), { ok: true });
    assert.deepEqual(tokens, ["Bearer expired-token", "Bearer refreshed-token"]);
    assert.equal(refreshes, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("api helper does not refresh a session for a wrong Admin password", async () => {
  let refreshes = 0;
  const { api } = loadApi({
    getSession: async () => ({ data: { session: { access_token: "valid-token" } } }),
    refreshSession: async () => {
      refreshes += 1;
      return { data: { session: null }, error: new Error("Unexpected refresh") };
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(
    { error: "Incorrect admin password." },
    { status: 401 },
  );
  try {
    await assert.rejects(api("verify-admin", { password: "wrong" }), /Incorrect admin password/);
    assert.equal(refreshes, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
