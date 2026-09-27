import { identity, failure } from "@/lib/server";
import {
  MAX_PROFILE_IMAGE_BYTES,
  validatedImageType,
} from "@/lib/profile-image";

export async function POST(req: Request) {
  let client: any;
  let path: string | undefined;
  try {
    const context = await identity(req);
    client = context.client;
    const file = (await req.formData()).get("avatar");
    if (!(file instanceof File))
      return Response.json({ error: "Choose an image file." }, { status: 400 });
    if (!file.size || file.size > MAX_PROFILE_IMAGE_BYTES)
      return Response.json({ error: "Image must be no larger than 2 MB." }, { status: 413 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = validatedImageType(file.type, bytes);
    if (!type)
      return Response.json(
        { error: "Use a valid JPEG, PNG, or WebP image." },
        { status: 415 },
      );

    const { data: prior, error: readError } = await client
      .from("profiles")
      .select("avatar_path")
      .eq("id", context.profile.id)
      .single();
    if (readError) throw readError;
    path = `${context.profile.id}/${crypto.randomUUID()}.${type.extension}`;
    const uploaded = await client.storage
      .from("profile-avatars")
      .upload(path, bytes, { contentType: type.mime, upsert: false });
    if (uploaded.error) throw uploaded.error;
    const updated = await client
      .from("profiles")
      .update({ avatar_path: path })
      .eq("id", context.profile.id);
    if (updated.error) {
      await client.storage.from("profile-avatars").remove([path]);
      throw updated.error;
    }
    if (prior?.avatar_path)
      await client.storage.from("profile-avatars").remove([prior.avatar_path]);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (client && path)
      await client.storage.from("profile-avatars").remove([path]);
    return failure(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const { client, profile } = await identity(req);
    const { data, error } = await client
      .from("profiles")
      .select("avatar_path")
      .eq("id", profile.id)
      .single();
    if (error) throw error;
    const updated = await client
      .from("profiles")
      .update({ avatar_path: null })
      .eq("id", profile.id);
    if (updated.error) throw updated.error;
    if (data.avatar_path) {
      const removed = await client.storage
        .from("profile-avatars")
        .remove([data.avatar_path]);
      if (removed.error) throw removed.error;
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}
