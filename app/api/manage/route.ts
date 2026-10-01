import { z } from "zod";
import { HttpError, identity, failure } from "@/lib/server";
import { canManage } from "@/lib/access";
import { usernameSchema, internalAddress } from "@/lib/usernames";

const accountRole = z.enum(["technical_judge", "performance_judge", "organizer"]);

function authCreationFailure(error: unknown): HttpError {
  const candidate = error as { code?: string; message?: string };
  const description = `${candidate?.code ?? ""} ${candidate?.message ?? ""}`.toLowerCase();
  if (/already.*(exist|registered)|duplicate|email_exists|user_exists/.test(description))
    return new HttpError("Username already exists.", 409);
  if (/password|weak_password/.test(description))
    return new HttpError("Password is weak or invalid. Use at least 6 characters and meet the password rules.", 400);
  return new HttpError("Failed to create the login account. Check the Auth service and try again.", 400);
}

function parseAccountInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(parsed.error.issues.map((issue) => issue.message).join(" "), 400);
  return parsed.data;
}

async function removeOrDisableUnprofiledAuthUser(client: any, id: string): Promise<string | null> {
  try {
    const removed = await client.auth.admin.deleteUser(id);
    if (!removed.error) return null;
  } catch {
    // Fall through to a long-term ban so a profile-less login cannot be used.
  }
  try {
    const banned = await client.auth.admin.updateUserById(id, { ban_duration: "876000h" });
    if (!banned.error) return "The orphan Auth account was disabled, but could not be removed; organizer cleanup is required.";
  } catch {
    // Report the failed rollback below without exposing Auth identifiers.
  }
  return "The new Auth account could not be removed or disabled. Contact the system administrator immediately.";
}

export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (!canManage(profile)) throw new Error("Organizer access required");
    const { action, data } = await req.json();
    let accountOutcome: Record<string, unknown> | undefined;
    if (["activate", "lock", "save"].includes(action)) {
      const parsed = action === "save"
        ? z.object({
            id: z.string().uuid().optional(),
            name: z.string().trim().min(1).max(100),
            division: z.string().min(1),
            position: z.number().int().min(1),
            status: z.enum(["upcoming", "active", "locked"]),
            dq: z.boolean(),
            archived: z.boolean(),
          }).parse(data)
        : z.object({ id: z.string().uuid() }).parse(data);
      const { error } = await client.rpc("manage_competitor", {
        p_actor: profile.id,
        p_action: action,
        p_data: parsed,
        p_development: false,
      });
      if (error) throw new Error(error.message);
    } else if (action === "assignments") {
      const input = z.object({
        division: z.string().trim().min(1).max(80),
        assignments: z.array(z.object({
          // This is only a private ordering key for the database, not an account slot.
          slot: z.number().int().min(1).max(10),
          user_id: z.string().uuid(),
          scoring_type: z.enum(["technical", "performance"]),
        })).min(2).max(10),
      }).parse(data);
      const { error } = await client.rpc("manage_judge_assignments", {
        p_actor: profile.id,
        p_division: input.division,
        p_assignments: input.assignments,
      });
      if (error) throw new Error(error.message);
    } else if (action === "division") {
      const input = z.object({
        name: z.string().trim().min(1).max(80),
        assignments: z.array(z.object({
          slot: z.number().int().min(1).max(10),
          user_id: z.string().uuid(),
          scoring_type: z.enum(["technical", "performance"]),
        })).min(2).max(10),
      }).strict().parse(data);
      const { error } = await client.rpc("create_division_with_roster", {
        p_actor: profile.id,
        p_division: input.name,
        p_assignments: input.assignments,
      });
      if (error) throw new Error(error.message);
    } else if (action === "remove_division") {
      const input = z.object({
        name: z.string().min(1).max(80).refine((name) => name.trim().length > 0),
        confirmation: z.string().min(1).max(80),
      }).parse(data);
      const { data: result, error } = await client.rpc("delete_division", {
        p_actor: profile.id,
        p_division: input.name,
        p_confirmation: input.confirmation,
      });
      if (error) throw new Error(error.message);
      return Response.json({ ok: true, divisionOutcome: result });
    } else if (action === "delete") {
      const input = z.object({ id: z.string().uuid() }).parse(data);
      const { error } = await client.rpc("delete_competitor", { p_actor: profile.id, p_id: input.id });
      if (error) throw new Error(error.message);
    } else if (action === "create_user" || action === "user") {
      // `user` remains a create-only alias for older clients. It deliberately
      // rejects `id`, so an old/stale create form can never fall into updates.
      const u = parseAccountInput(z.object({
        name: z.string().trim().min(1, "Enter a display name.").max(100),
        username: usernameSchema,
        role: accountRole,
        password: z.string().min(6, "Password must be at least 6 characters.").max(256, "Password is too long."),
      }).strict(), data);
      if (["alexandertai", "organizer"].includes(u.username))
        throw new HttpError("That username is reserved for a protected account.", 409);

      // usernameSchema lowercases before lookup and the database constraint is
      // lowercase-only, making this check case-insensitive for accepted input.
      const duplicate = await client.from("profiles").select("id")
        .eq("username", u.username).maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (duplicate.data) throw new HttpError("Username already exists.", 409);

      let id: string | undefined;
      try {
        const created = await client.auth.admin.createUser({
          email: internalAddress(u.username), password: u.password, email_confirm: true,
        });
        if (created.error) throw authCreationFailure(created.error);
        id = created.data.user?.id;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw authCreationFailure(error);
      }
      if (!id || id === profile.id)
        throw new Error("Auth did not return a distinct new account ID; no existing profile was changed.");

      let profileInsertError: { code?: string } | null = null;
      try {
        const inserted = await client.from("profiles").insert({
          id, name: u.name, username: u.username, role: u.role, active: true,
          archived: false, is_admin: u.role === "organizer",
        });
        profileInsertError = inserted.error;
      } catch (error) {
        profileInsertError = error as { code?: string };
      }
      if (profileInsertError) {
        const cleanup = await removeOrDisableUnprofiledAuthUser(client, id);
        if (profileInsertError.code === "23505")
          throw new HttpError(cleanup ? `Username already exists. ${cleanup}` : "Username already exists.", 409);
        throw new HttpError(cleanup
          ? `Profile creation failed. ${cleanup}`
          : "Profile creation failed; the temporary Auth account was removed. Please retry or contact the organizer.", 500);
      }

      const audit = await client.from("audit").insert({
        user_id: profile.id, action: "account_create", prior: null,
        next: { id, name: u.name, username: u.username, role: u.role },
      });
      if (audit.error) throw new Error("Account created, but audit logging failed. Contact the organizer.");
      accountOutcome = { createdAccount: { id, username: u.username, role: u.role } };
    } else if (action === "update_user") {
      const u = parseAccountInput(z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1, "Enter a display name.").max(100),
        username: usernameSchema,
        role: accountRole,
        password: z.string().min(6, "Password must be at least 6 characters.").max(256, "Password is too long.").optional(),
      }).strict(), data);
      const priorResult = await client.from("profiles").select("id,name,username,role,active,is_admin,archived")
        .eq("id", u.id).maybeSingle();
      if (priorResult.error) throw priorResult.error;
      const prior = priorResult.data;
      if (!prior) throw new Error("Account not found");
      if (prior.username?.toLowerCase() === "alexandertai") {
        throw new HttpError("alexandertai is protected from Server Access Control account changes.", 403);
      } else if (prior.username?.toLowerCase() === "organizer") {
        throw new HttpError("The organizer account is protected from Server Access Control account changes.", 403);
      } else if (["alexandertai", "organizer"].includes(u.username)) {
        throw new HttpError("That username is reserved for a protected account.", 409);
      }
      const duplicate = await client.from("profiles").select("id").eq("username", u.username)
        .neq("id", u.id).maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (duplicate.data) throw new HttpError("Username already exists.", 409);
      if (prior.role === "organizer" && prior.active && u.role !== "organizer") {
        const { count, error } = await client.from("profiles").select("id", { count: "exact", head: true }).eq("role", "organizer").eq("active", true);
        if (error) throw error;
        if ((count ?? 0) <= 1) throw new Error("At least one active Organizer account must remain");
      }

      if (u.password) {
        const updated = await client.auth.admin.updateUserById(u.id, { password: u.password });
        if (updated.error) {
          const message = `${updated.error.message ?? ""}`.toLowerCase();
          if (/password|weak_password/.test(message))
            throw new HttpError("Password is weak or invalid. Use at least 6 characters and meet the password rules.", 400);
          throw new HttpError("Failed to update the login password. No profile changes were saved.", 400);
        }
      }
      if (prior.role !== u.role) {
        const changed = await client.rpc("change_judge_account_role", {
          p_actor: profile.id, p_target: u.id, p_role: u.role,
        });
        if (changed.error) throw new Error(changed.error.message);
      }
      const updated = await client.from("profiles").update({
        name: u.name, username: u.username,
        is_admin: u.role === "organizer",
      }).eq("id", u.id).select("id").single();
      if (updated.error) {
        if (updated.error.code === "23505") throw new HttpError("Username already exists.", 409);
        throw updated.error;
      }
      const audit = await client.from("audit").insert({
        user_id: profile.id, action: "account_update",
        prior: { id: u.id, name: prior.name, username: prior.username, role: prior.role, active: prior.active },
        next: { id: u.id, name: u.name, username: u.username, role: u.role, active: prior.active },
      });
      if (audit.error) throw new Error("Account updated, but audit logging failed. Contact the organizer.");
    } else if (action === "reactivate_user") {
      const input = z.object({ id: z.string().uuid() }).parse(data);
      const target = await client.from("profiles").select("id,username").eq("id", input.id).maybeSingle();
      if (target.error) throw target.error;
      if (!target.data) throw new Error("Account not found");
      if (["alexandertai", "organizer"].includes(target.data.username?.toLowerCase() ?? ""))
        throw new HttpError("This account is protected from Server Access Control changes.", 403);
      const { error } = await client.rpc("reactivate_judge_account", { p_actor: profile.id, p_target: input.id });
      if (error) throw new Error(error.message);
    } else if (action === "remove_user") {
      const input = z.object({ id: z.string().uuid(), confirmation: z.string().min(1).max(80) }).parse(data);
      const target = await client.from("profiles").select("id,username,name,role,active,avatar_path").eq("id", input.id).maybeSingle();
      if (target.error) throw target.error;
      if (!target.data) throw new Error("Account not found");
      if (["alexandertai", "organizer"].includes(target.data.username?.toLowerCase() ?? ""))
        throw new HttpError("This is a protected Organizer account and cannot be deleted.", 403);
      if (input.confirmation !== target.data.username && input.confirmation !== "DELETE JUDGE")
        throw new Error("Type the exact username or DELETE JUDGE to confirm permanent deletion.");
      const history = await client.from("submissions").select("id", { count: "exact", head: true }).eq("user_id", input.id);
      if (history.error) throw history.error;
      const avatarPath = target.data.avatar_path;
      let avatarBackup: Blob | null = null;
      if (avatarPath) {
        const downloaded = await client.storage.from("profile-avatars").download(avatarPath);
        if (downloaded.error) throw new Error(`The judge’s private profile image could not be prepared for deletion: ${downloaded.error.message}`);
        avatarBackup = downloaded.data;
        const removed = await client.storage.from("profile-avatars").remove([avatarPath]);
        if (removed.error) throw new Error(`The judge’s private profile image could not be removed: ${removed.error.message}`);
      }
      const prepared = await client.rpc("prepare_judge_deletion", { p_actor: profile.id, p_target: input.id });
      if (prepared.error) {
        if (avatarPath && avatarBackup) await client.storage.from("profile-avatars").upload(avatarPath, avatarBackup, { contentType: avatarBackup.type || "image/webp", upsert: true });
        throw new Error(prepared.error.message);
      }
      const deleted = await client.auth.admin.deleteUser(input.id);
      if (deleted.error) {
        const cancelled = await client.rpc("cancel_judge_deletion", { p_actor: profile.id, p_target: input.id });
        if (avatarPath && avatarBackup) {
          const restored = await client.storage.from("profile-avatars").upload(avatarPath, avatarBackup, { contentType: avatarBackup.type || "image/webp", upsert: true });
          if (restored.error) throw new Error(`Account deletion failed and access was restored, but the private avatar restoration needs organizer attention: ${restored.error.message}`);
        }
        if (cancelled.error) throw new Error(`Account deletion failed; contact support to restore the account assignment: ${cancelled.error.message}`);
        throw new Error(`Account was not deleted. ${deleted.error.message}`);
      }
      accountOutcome = { permanentlyDeleted: true, submittedScoresPreserved: (history.count ?? 0) > 0 };
    } else throw new Error("Unknown action");
    return Response.json({ ok: true, ...(accountOutcome ?? {}) });
  } catch (e) {
    return failure(e);
  }
}
