import { createClient } from "@supabase/supabase-js";
export const demo = process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";
export const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      )
    : null;

export class ApiResponseError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export async function api<T = any>(
  path: string,
  body?: unknown,
  options?: {
    adminUnlockToken?: string;
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  },
) {
  const hasBody = body !== undefined;
  const request = (accessToken?: string) => fetch(`/api/${path}`, {
    method: options?.method ?? (hasBody ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken ?? ""}`,
      ...(options?.adminUnlockToken
        ? { "x-hidc-admin-unlock": options.adminUnlockToken }
        : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const read = async (response: Response) => {
    const responseText = await response.text();
    let data: { error?: unknown } = {};
    if (responseText.trim()) {
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (parsed && typeof parsed === "object") data = parsed as { error?: unknown };
      } catch {
        if (response.ok) return { data: {} as T, response };
      }
    }
    return { data: data as T, response };
  };
  const session = await supabase?.auth.getSession();
  let result = await read(await request(session?.data.session?.access_token));
  // A cached workspace can outlive a Supabase access token. Refresh once when
  // the server specifically rejects identity, then replay the same request.
  // Other 401s (for example an incorrect password) must not trigger a retry.
  if (
    result.response.status === 401 &&
    (result.data as { error?: unknown }).error === "Sign in required" &&
    supabase
  ) {
    const refreshed = await supabase.auth.refreshSession();
    const accessToken = refreshed.data.session?.access_token;
    if (!refreshed.error && accessToken) {
      result = await read(await request(accessToken));
    }
  }
  const { data, response: res } = result;
  if (!res.ok) {
    const message = typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed (HTTP ${res.status})`;
    throw new ApiResponseError(message, res.status);
  }
  return data as T;
}
