import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { identity, failure } from "@/lib/server";
import { internalAddress, usernameSchema } from "@/lib/usernames";

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
        return Response.json(
          { error: "Enter your current password to change your username or password." },
          { status: 400 },
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
        return Response.json({ error: "Current password is incorrect." }, { status: 401 });
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
        return Response.json({ error: "That username is already in use." }, { status: 409 });
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
        return Response.json({ error: "That username is already in use." }, { status: 409 });
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

    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}
