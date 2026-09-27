import { z } from "zod";
import { db } from "@/lib/server";
import { usernameSchema } from "@/lib/usernames";
export async function POST(req: Request) {
  try {
    const input = z
      .object({
        username: usernameSchema,
        password: z.string().min(1).max(256),
      })
      .parse(await req.json());
    const client = db();
    const { data: profile } = await client
      .from("profiles")
      .select("id,active")
      .eq("username", input.username)
      .single();
    if (!profile?.active) throw new Error("Invalid username or password");
    // Resolve even older accounts privately; existing Auth identifiers need not change.
    const { data } = await client.auth.admin.getUserById(profile.id);
    if (!data.user?.email) throw new Error("Invalid username or password");
    const result = await client.auth.signInWithPassword({
      email: data.user.email,
      password: input.password,
    });
    if (result.error || !result.data.session)
      throw new Error("Invalid username or password");
    return Response.json(
      {
        access_token: result.data.session.access_token,
        refresh_token: result.data.session.refresh_token,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Invalid username or password" },
      { status: 401 },
    );
  }
}
