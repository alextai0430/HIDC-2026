import { identity } from "@/lib/server";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
});

function validPreferences(value: unknown): value is { enabled: boolean; keys: Record<string, string> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "enabled,keys" || typeof candidate.enabled !== "boolean") return false;
  if (!candidate.keys || typeof candidate.keys !== "object" || Array.isArray(candidate.keys)) return false;
  const entries = Object.entries(candidate.keys as Record<string, unknown>);
  if (entries.length > 100 || entries.some(([action, key]) =>
    !/^[\w .:+-]{1,80}$/.test(action) || typeof key !== "string" || key.length > 20)) return false;
  const bindings = entries.map(([, key]) => typeof key === "string" ? key.trim().toLowerCase() : "").filter(Boolean);
  return new Set(bindings).size === bindings.length;
}

export async function PATCH(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "preferences,updatedAt" ||
      !validPreferences(input.preferences) || typeof input.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(input.updatedAt))) {
      return json({ error: "Choose valid, unique hotkey bindings before saving." }, 400);
    }
    const requestedAt = new Date(input.updatedAt).toISOString();
    if (Date.parse(requestedAt) > Date.now() + 5 * 60 * 1000)
      return json({ error: "This device clock is too far ahead to sync hotkey settings." }, 400);
    const update = await client.from("profiles").update({
      hotkey_preferences: input.preferences,
      hotkeys_updated_at: requestedAt,
    }).eq("id", profile.id).lt("hotkeys_updated_at", requestedAt)
      .select("hotkey_preferences,hotkeys_updated_at").maybeSingle();
    if (update.error) throw update.error;
    if (update.data) return json({ saved: true, conflict: false, preferences: update.data.hotkey_preferences, updatedAt: update.data.hotkeys_updated_at });
    const current = await client.from("profiles").select("hotkey_preferences,hotkeys_updated_at").eq("id", profile.id).single();
    if (current.error) throw current.error;
    return json({ saved: false, conflict: true, preferences: current.data.hotkey_preferences, updatedAt: current.data.hotkeys_updated_at });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hotkey settings could not be saved.";
    const status = error instanceof SyntaxError ? 400 : message === "Sign in required" ? 401 : message === "Account inactive or not assigned" ? 403 : 500;
    return json({ error: status === 500 ? "Hotkey settings could not be saved. Please try again." : error instanceof SyntaxError ? "Invalid hotkey settings request." : message }, status);
  }
}

export const POST = PATCH;
export const GET = async (req: Request) => {
  try {
    const { profile } = await identity(req);
    return json({ preferences: profile.hotkey_preferences ?? { enabled: true, keys: {} }, updatedAt: profile.hotkeys_updated_at ?? "1970-01-01T00:00:00.000Z" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return json({ error: message }, message === "Sign in required" ? 401 : 403);
  }
};
