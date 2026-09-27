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
export async function api(path: string, body?: unknown) {
  const session = await supabase?.auth.getSession();
  const res = await fetch(`/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.data.session?.access_token ?? ""}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
