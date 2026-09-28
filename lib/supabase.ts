import { createClient } from "@supabase/supabase-js";
export const demo = process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";
export const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      )
    : null;
export async function api<T = any>(
  path: string,
  body?: unknown,
  options?: {
    adminUnlockToken?: string;
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  },
) {
  const session = await supabase?.auth.getSession();
  const hasBody = body !== undefined;
  const res = await fetch(`/api/${path}`, {
    method: options?.method ?? (hasBody ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.data.session?.access_token ?? ""}`,
      ...(options?.adminUnlockToken
        ? { "x-hidc-admin-unlock": options.adminUnlockToken }
        : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const responseText = await res.text();
  let data: { error?: unknown } = {};
  if (responseText.trim()) {
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (parsed && typeof parsed === "object") data = parsed as { error?: unknown };
    } catch {
      if (res.ok) return {} as T;
    }
  }
  if (!res.ok) {
    const message = typeof data.error === "string" ? data.error : `Request failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  return data as T;
}
