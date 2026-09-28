import { identity } from "@/lib/server";
import { defaultAppearance, isAppearancePreferences } from "@/lib/appearance";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof SyntaxError) return json({ error: "Invalid appearance settings request." }, 400);
  if (error instanceof Error && error.message === "Sign in required") return json({ error: error.message }, 401);
  if (error instanceof Error && error.message === "Account inactive or not assigned") return json({ error: error.message }, 403);
  return json({ error: "Appearance settings could not be saved. Please try again." }, 500);
}

export async function GET(req: Request) {
  try {
    const { profile } = await identity(req);
    return json({
      preferences: isAppearancePreferences(profile.appearance_preferences)
        ? profile.appearance_preferences
        : defaultAppearance,
      updatedAt: profile.appearance_updated_at ?? new Date(0).toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "preferences,updatedAt" ||
      !isAppearancePreferences(input.preferences) ||
      typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) {
      return json({ error: "Choose a valid appearance before saving." }, 400);
    }
    const requestedAt = new Date(input.updatedAt).toISOString();
    if (Date.parse(requestedAt) > Date.now() + 5 * 60 * 1000)
      return json({ error: "This device clock is too far ahead to sync appearance settings." }, 400);
    const previousTime = profile.appearance_updated_at ?? new Date(0).toISOString();
    if (Date.parse(requestedAt) <= Date.parse(previousTime)) {
      const current = await client.from("profiles")
        .select("appearance_preferences,appearance_updated_at")
        .eq("id", profile.id)
        .single();
      if (current.error) throw current.error;
      return json({
        saved: false,
        conflict: true,
        preferences: isAppearancePreferences(current.data.appearance_preferences)
          ? current.data.appearance_preferences
          : defaultAppearance,
        updatedAt: current.data.appearance_updated_at,
      });
    }
    const update = await client.from("profiles")
      .update({
        appearance_preferences: input.preferences,
        appearance_updated_at: requestedAt,
      })
      .eq("id", profile.id)
      .lt("appearance_updated_at", requestedAt)
      .select("appearance_preferences,appearance_updated_at")
      .maybeSingle();
    if (update.error) throw update.error;
    if (update.data) return json({ saved: true, conflict: false, preferences: update.data.appearance_preferences, updatedAt: update.data.appearance_updated_at });

    const current = await client.from("profiles")
      .select("appearance_preferences,appearance_updated_at")
      .eq("id", profile.id)
      .single();
    if (current.error) throw current.error;
    return json({
      saved: false,
      conflict: true,
      preferences: isAppearancePreferences(current.data.appearance_preferences)
        ? current.data.appearance_preferences
        : defaultAppearance,
      updatedAt: current.data.appearance_updated_at,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = (req: Request) => PATCH(req);
export const PUT = (req: Request) => json({ error: "Method not allowed." }, 405);
export const DELETE = (req: Request) => json({ error: "Method not allowed." }, 405);
export const OPTIONS = (req: Request) => json({ error: "Method not allowed." }, 405);
