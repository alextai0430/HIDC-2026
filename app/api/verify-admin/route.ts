import { z } from "zod";
import { failure, identity } from "@/lib/server";
import {
  matchesBootstrapPassword,
  verifyAdminTabPassword,
} from "@/lib/admin-password";
import { createAdminUnlockToken } from "@/lib/admin-unlock";

export async function POST(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const expected = process.env.ADMIN_VIEW_PASSWORD;
    const body = z
      .object({ password: z.string().max(256) })
      .parse(await req.json());
    const { data: latestChange, error } = await client
      .from("audit")
      .select("next")
      .eq("action", "admin_tab_password_change")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Could not verify the Admin-tab password.");
    const savedHash = latestChange?.next?.password_hash;
    if (!savedHash && !expected) {
      return Response.json(
        { error: "Admin password is not configured." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const valid = savedHash
      ? verifyAdminTabPassword(body.password, savedHash)
      : matchesBootstrapPassword(body.password, expected!);
    if (!valid) {
      return Response.json(
        { error: "Incorrect admin password." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { unlockToken: createAdminUnlockToken(profile.id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
