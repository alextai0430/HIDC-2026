import "server-only";
import { createClient } from "@supabase/supabase-js";
import { Profile } from "./model";

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

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
  if (error || !data.user) throw new HttpError("Sign in required", 401);
  const { data: profile } = await client
    .from("profiles")
    .select("*")
    .eq("id", data.user.id)
    .single();
  if (!profile?.active) throw new HttpError("Account inactive or not assigned", 403);
  return { client, profile: profile as Profile };
}
export function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  const status = error instanceof HttpError
    ? error.status
    : message === "Sign in required"
      ? 401
      : 400;
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
