import { z } from "zod";
import { canManage } from "@/lib/access";
import { hashAdminTabPassword } from "@/lib/admin-password";
import { failure, identity } from "@/lib/server";

export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (!canManage(profile)) throw new Error("Administrator access required");
    const { password } = z
      .object({ password: z.string().min(6).max(256) })
      .parse(await req.json());
    const { error } = await client.from("audit").insert({
      user_id: profile.id,
      action: "admin_tab_password_change",
      next: { password_hash: hashAdminTabPassword(password) },
    });
    if (error) throw new Error("Could not save the new Admin-tab password.");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
