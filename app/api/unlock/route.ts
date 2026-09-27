import { adminProtectionEnabled } from "@/lib/access";
import { identity, failure, secureEqual, unlockValue } from "@/lib/server";
import { cookies } from "next/headers";

export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const { password, lock } = await req.json();
    const jar = await cookies();
    if (lock) {
      jar.delete("hidc-admin");
      return Response.json({ ok: true });
    }
    if (!adminProtectionEnabled) return Response.json({ ok: true });
    const attempt = await client.rpc("consume_unlock_attempt", {
      p_user: profile.id,
    });
    if (attempt.error || !attempt.data)
      throw new Error("Too many attempts. Try again in 15 minutes.");
    const expected = process.env.SCORING_ADMIN_PASSWORD;
    if (
      !expected ||
      typeof password !== "string" ||
      !secureEqual(password, expected)
    ) {
      throw new Error("Invalid admin password");
    }
    await client.from("unlock_attempts").delete().eq("user_id", profile.id);
    jar.set("hidc-admin", unlockValue(profile.id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 14400,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
