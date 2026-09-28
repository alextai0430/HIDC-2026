import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { identity } from "@/lib/server";
import { internalAddress, usernameSchema } from "@/lib/usernames";

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function methodNotAllowed() {
  return json({ error: "Method not allowed." }, 405);
}

export const GET = methodNotAllowed;
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

function profileFailure(error: unknown) {
  if (error instanceof z.ZodError)
    return json({ error: error.issues[0]?.message ?? "Invalid profile update." }, 400);
  if (error instanceof SyntaxError)
    return json({ error: "Invalid profile request body." }, 400);
  if (error instanceof Error) {
    if (error.message === "Sign in required") return json({ error: error.message }, 401);
    if (error.message === "Account inactive or not assigned")
      return json({ error: error.message }, 403);
  }
  return json({ error: "Profile settings could not be saved. Please try again." }, 500);
}

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    username: usernameSchema,
    currentPassword: z.string().max(256).optional(),
    newPassword: z.string().min(6).max(256).optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const input = updateSchema.parse(await req.json());
    const usernameChanged = input.username !== profile.username;
    const passwordChanged = !!input.newPassword;
    const protectedChange = usernameChanged || passwordChanged;

    const localDemo =
      process.env.NODE_ENV !== "production" &&
      process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";
    if (protectedChange && !localDemo) {
      if (!input.currentPassword)
        return json(
          { error: "Enter your current password to change your username or password." },
          400,
        );
      const { data: authResult, error: authError } =
        await client.auth.admin.getUserById(profile.id);
      const email = authResult.user?.email;
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (authError || !email || !url || !anon)
        throw new Error("Unable to verify the current password.");
      const verifier = createClient(url, anon, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const checked = await verifier.auth.signInWithPassword({
        email,
        password: input.currentPassword,
      });
      if (checked.error)
        return json({ error: "Current password is incorrect." }, 401);
    }

    if (usernameChanged) {
      const duplicate = await client
        .from("profiles")
        .select("id")
        .eq("username", input.username)
        .neq("id", profile.id)
        .maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (duplicate.data)
        return json({ error: "That username is already in use." }, 409);
    }

    const profileUpdate: Record<string, string> = {};
    if (input.name !== profile.name) profileUpdate.name = input.name;
    if (usernameChanged) profileUpdate.username = input.username;
    if (Object.keys(profileUpdate).length) {
      const { error } = await client
        .from("profiles")
        .update(profileUpdate)
        .eq("id", profile.id);
      if (error?.code === "23505")
        return json({ error: "That username is already in use." }, 409);
      if (error) throw error;
    }

    if (protectedChange) {
      const update: { email?: string; email_confirm?: boolean; password?: string } = {};
      if (usernameChanged) {
        update.email = internalAddress(input.username);
        update.email_confirm = true;
      }
      if (passwordChanged) update.password = input.newPassword;
      const result = await client.auth.admin.updateUserById(profile.id, update);
      if (result.error) {
        if (Object.keys(profileUpdate).length)
          await client.from("profiles").update({
            name: profile.name,
            username: profile.username,
          }).eq("id", profile.id);
        throw new Error("Account settings could not be saved. Please try again.");
      }
    }

    return json({ ok: true });
  } catch (e) {
    return profileFailure(e);
  }
}
