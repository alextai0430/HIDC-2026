import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

function loadApi() {
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
    ? { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) } }) }
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
