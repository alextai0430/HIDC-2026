import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { Profile } from "./model";
import { adminProtectionEnabled, isAdministrator } from "./access";
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
export function secureEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function signature(value: string) {
  const secret = process.env.ADMIN_COOKIE_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Admin cookie secret must have at least 32 characters");
  return createHmac("sha256", secret).update(value).digest("hex");
}
export function unlockValue(user: string) {
  const body = `${user}.${Date.now() + 4 * 60 * 60 * 1000}`;
  return `${body}.${signature(body)}`;
}
export async function protectedAccess(profile: Profile) {
  if (!profile.active) return false;
  if (!adminProtectionEnabled || isAdministrator(profile)) return true;
  const value = (await cookies()).get("hidc-admin")?.value;
  if (!value) return false;
  const [id, expiry, sig] = value.split(".");
  return (
    id === profile.id &&
    Number(expiry) > Date.now() &&
    secureEqual(sig ?? "", signature(`${id}.${expiry}`))
  );
}
export function failure(error: unknown) {
  return Response.json(
    { error: error instanceof Error ? error.message : "Request failed" },
    { status: 400 },
  );
}
