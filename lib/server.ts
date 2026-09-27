import "server-only";
import { createClient } from "@supabase/supabase-js";
import { Profile } from "./model";
export function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export async function identity(req: Request) {
  const client = db();
  const { data, error } = await client.auth.getUser(
    req.headers.get("Authorization")?.replace("Bearer ", "") ?? "",
  );
  if (error || !data.user) throw new Error("Sign in required");
  const { data: profile } = await client
    .from("profiles")
    .select("*")
    .eq("id", data.user.id)
    .single();
  if (!profile?.active) throw new Error("Account inactive or not assigned");
  return { client, profile: profile as Profile };
}
export function failure(error: unknown) {
  return Response.json(
    { error: error instanceof Error ? error.message : "Request failed" },
    { status: 400 },
  );
}
