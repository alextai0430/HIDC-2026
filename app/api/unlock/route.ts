import { identity, failure } from "@/lib/server";

// Disabled compatibility endpoint. A password cannot grant global access.
export async function POST(req: Request) {
  try {
    await identity(req);
    return Response.json(
      { error: "Score access is determined by your account." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
