import { identity, failure } from "@/lib/server";
import { canManage } from "@/lib/access";
import { sanitizeAuditRows } from "@/lib/audit";
export async function GET(req: Request) {
  try {
    const { client, profile } = await identity(req);
    if (!canManage(profile)) throw new Error("Administrator access required");
    const before = new URL(req.url).searchParams.get("before");
    if (!before || !/^\d+$/.test(before))
      throw new Error("Invalid audit cursor");
    const { data, error } = await client
      .from("audit")
      .select("*")
      .lt("id", before)
      .order("id", { ascending: false })
      .limit(250);
    if (error) throw new Error(error.message);
    return Response.json(sanitizeAuditRows(data ?? []), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
