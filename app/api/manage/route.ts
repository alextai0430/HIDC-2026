import { z } from "zod";
import { identity, failure } from "@/lib/server";
import { canManage } from "@/lib/access";
import { usernameSchema, internalAddress } from "@/lib/usernames";

const accountRole = z.enum(["technical_judge", "performance_judge", "organizer"]);

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
      const name = z.string().trim().min(1).max(80).parse(data.name);
      const existing = await client.from("divisions").select("name").eq("name", name).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (existing.data) throw new Error("That division already exists. Select it from the Division list instead.");
      const { error } = await client.from("divisions").insert({ name });
      if (error?.code === "23505") throw new Error("That division already exists. Select it from the Division list instead.");
      if (error) throw new Error(error.message);
      const audit = await client.from("audit").insert({ user_id: profile.id, action: "division_create", next: { name } });
      if (audit.error) throw new Error("Division created, but audit logging failed. Contact the organizer.");
    } else if (action === "delete") {
      const input = z.object({ id: z.string().uuid() }).parse(data);
      const { error } = await client.rpc("delete_competitor", { p_actor: profile.id, p_id: input.id });
      if (error) throw new Error(error.message);
    } else if (action === "user") {
      const u = z.object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(100),
        username: usernameSchema,
        role: accountRole,
        password: z.string().min(6).max(256).optional(),
      }).parse(data);
      if (!u.id && !u.password) throw new Error("A password is required for a new account");

      const duplicate = await client.from("profiles").select("id").eq("username", u.username)
        .neq("id", u.id ?? "00000000-0000-0000-0000-000000000000").maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (duplicate.data) throw new Error("Username is already in use");

      const priorResult = u.id
        ? await client.from("profiles").select("id,name,username,role,active,is_admin,archived").eq("id", u.id).maybeSingle()
        : null;
      if (priorResult?.error) throw priorResult.error;
      const prior = priorResult?.data ?? null;
      if (u.id && !prior) throw new Error("Account not found");
      if (prior?.username?.toLowerCase() === "alexandertai") {
        if (u.username.toLowerCase() !== "alexandertai" || u.role !== "organizer")
          throw new Error("alexandertai must remain the protected full-access Organizer account");
      }
      if (prior?.role === "organizer" && prior.active && u.role !== "organizer") {
        const { count, error } = await client.from("profiles").select("id", { count: "exact", head: true }).eq("role", "organizer").eq("active", true);
        if (error) throw error;
        if ((count ?? 0) <= 1) throw new Error("At least one active Organizer account must remain");
      }

      let id = u.id;
      if (!id) {
        const created = await client.auth.admin.createUser({
          email: internalAddress(u.username), password: u.password!, email_confirm: true,
        });
        if (created.error) throw created.error;
        id = created.data.user.id;
        const inserted = await client.from("profiles").insert({
          id, name: u.name, username: u.username, role: u.role, active: true,
          archived: false, is_admin: u.role === "organizer",
        });
        if (inserted.error) {
          await client.auth.admin.deleteUser(id);
          throw inserted.error;
        }
        const audit = await client.from("audit").insert({
          user_id: profile.id, action: "account_create", prior: null,
          next: { id, name: u.name, username: u.username, role: u.role },
        });
        if (audit.error) throw new Error("Account created, but audit logging failed. Contact the organizer.");
      } else {
        if (u.password) {
          const updated = await client.auth.admin.updateUserById(id, { password: u.password });
          if (updated.error) throw updated.error;
        }
        if (prior!.role !== u.role) {
          const changed = await client.rpc("change_judge_account_role", {
            p_actor: profile.id, p_target: id, p_role: u.role,
          });
          if (changed.error) throw new Error(changed.error.message);
        }
        const updated = await client.from("profiles").update({
          name: u.name, username: u.username,
          is_admin: u.role === "organizer",
        }).eq("id", id).select("id").single();
        if (updated.error) throw updated.error;
        const audit = await client.from("audit").insert({
          user_id: profile.id, action: "account_update",
          prior: { id, name: prior!.name, username: prior!.username, role: prior!.role, active: prior!.active },
          next: { id, name: u.name, username: u.username, role: u.role, active: prior!.active },
        });
        if (audit.error) throw new Error("Account updated, but audit logging failed. Contact the organizer.");
      }
    } else if (action === "reactivate_user") {
      const input = z.object({ id: z.string().uuid() }).parse(data);
      const target = await client.from("profiles").select("id,username").eq("id", input.id).maybeSingle();
      if (target.error) throw target.error;
      if (!target.data) throw new Error("Account not found");
      if (target.data.username?.toLowerCase() === "alexandertai") throw new Error("alexandertai is the protected full-access Organizer account");
      const { error } = await client.rpc("reactivate_judge_account", { p_actor: profile.id, p_target: input.id });
      if (error) throw new Error(error.message);
    } else if (action === "remove_user") {
      const input = z.object({ id: z.string().uuid(), confirmation: z.string().min(1).max(80) }).parse(data);
      const target = await client.from("profiles").select("id,username,name,role,active,avatar_path").eq("id", input.id).maybeSingle();
      if (target.error) throw target.error;
      if (!target.data) throw new Error("Account not found");
      if (target.data.username?.toLowerCase() === "alexandertai") throw new Error("alexandertai is the protected full-access Organizer account");
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
