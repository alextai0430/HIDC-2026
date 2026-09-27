import { z } from "zod";
import { identity, failure } from "@/lib/server";
import { adminProtectionEnabled, canManage } from "@/lib/access";
import { usernameSchema, internalAddress } from "@/lib/usernames";
export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (!canManage(profile))
      throw new Error("Server organizer access required");
    const { action, data } = await req.json();
    if (["activate", "lock", "save"].includes(action)) {
      const parsed =
        action === "save"
          ? z
              .object({
                id: z.string().uuid().optional(),
                name: z.string().trim().min(1).max(100),
                division: z.string().min(1),
                position: z.number().int().min(1),
                status: z.enum(["upcoming", "active", "locked"]),
                dq: z.boolean(),
                archived: z.boolean(),
              })
              .parse(data)
          : z.object({ id: z.string().uuid() }).parse(data);
      const { error } = await client.rpc("manage_competitor", {
        p_actor: profile.id,
        p_action: action,
        p_data: parsed,
        p_development: !adminProtectionEnabled,
      });
      if (error) throw new Error(error.message);
    } else if (action === "division") {
      const name = z.string().trim().min(1).max(80).parse(data.name);
      const { error } = await client.from("divisions").insert({ name });
      if (error) throw new Error(error.message);
      const audit = await client.from("audit").insert({
        user_id: profile.id,
        action: "division_create",
        next: { name },
      });
      if (audit.error)
        throw new Error(
          "Division created, but audit logging failed. Contact the organizer.",
        );
    } else if (action === "user") {
      const u = z
        .object({
          id: z.string().uuid().optional(),
          username: usernameSchema,
          password: z.string().min(6).optional(),
          slot: z.number().int().min(1).max(5),
          active: z.boolean(),
        })
        .parse(data);
      let id = u.id;
      const duplicate = await client
        .from("profiles")
        .select("id")
        .eq("username", u.username)
        .neq("id", id ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle();
      if (duplicate.data) throw new Error("Username is already in use");
      const prior = id
        ? (await client.from("profiles").select("*").eq("id", id).single()).data
        : null;
      if (id === profile.id && profile.role === "server_admin")
        throw new Error("Cannot modify organizer through judge management");
      if (id) {
        const existing = (
          await client.from("profiles").select("*").eq("id", id).single()
        ).data;
        if (existing?.role !== "judge")
          throw new Error("Only judge accounts can be modified");
      }
      const occupied = (
        await client
          .from("profiles")
          .select("id")
          .eq("slot", u.slot)
          .eq("active", true)
          .neq("id", id ?? "00000000-0000-0000-0000-000000000000")
      ).data;
      if (u.active && occupied?.length)
        throw new Error("Deactivate the current slot holder first");
      if (!id) {
        if (!u.password) throw new Error("Password required");
        const result = await client.auth.admin.createUser({
          email: internalAddress(u.username),
          password: u.password,
          email_confirm: true,
        });
        if (result.error) throw result.error;
        id = result.data.user.id;
      } else {
        const result = await client.auth.admin.updateUserById(id, {
          // Username changes do not rotate Auth identifiers or invalidate pending work.
          ...(u.password ? { password: u.password } : {}),
        });
        if (result.error) throw result.error;
      }
      const { error } = await client.from("profiles").upsert({
        id,
        name: u.username,
        username: u.username,
        slot: u.slot,
        active: u.active,
        role: "judge",
      });
      if (error) {
        if (!u.id) await client.auth.admin.deleteUser(id!);
        throw new Error(error.message);
      }
      const audit = await client.from("audit").insert({
        user_id: profile.id,
        action: "user",
        prior,
        next: { id, username: u.username, slot: u.slot, active: u.active },
      });
      if (audit.error)
        throw new Error(
          "Account updated, but audit logging failed. Contact the organizer.",
        );
    } else throw new Error("Unknown action");
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
