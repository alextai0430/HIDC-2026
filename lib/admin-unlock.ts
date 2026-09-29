import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const unlockLifetimeSeconds = 8 * 60 * 60;

type UnlockClaims = {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
};

function signingSecret() {
  const secret =
    process.env.ADMIN_UNLOCK_SIGNING_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("Admin unlock signing is not configured.");
  }
  return secret;
}

function signature(payload: string) {
  return createHmac("sha256", signingSecret())
    .update(`hidc-admin-unlock.v1.${payload}`)
    .digest();
}

export function createAdminUnlockToken(userId: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: UnlockClaims = {
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + unlockLifetimeSeconds,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `v1.${payload}.${signature(payload).toString("base64url")}`;
}

export function hasValidAdminUnlock(token: string | null, userId: string) {
  if (!token) return false;
  const [version, payload, encodedSignature, extra] = token.split(".");
  if (version !== "v1" || !payload || !encodedSignature || extra) return false;

  try {
    const suppliedSignature = Buffer.from(encodedSignature, "base64url");
    const expectedSignature = signature(payload);
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      return false;
    }

    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as UnlockClaims;
    const now = Math.floor(Date.now() / 1000);
    return (
      claims.sub === userId &&
      Number.isInteger(claims.iat) &&
      Number.isInteger(claims.exp) &&
      claims.iat <= now + 30 &&
      claims.exp > now &&
      claims.exp - claims.iat === unlockLifetimeSeconds &&
      typeof claims.nonce === "string" &&
      claims.nonce.length >= 16
    );
  } catch {
    return false;
  }
}

export function requestHasAdminUnlock(req: Request, userId: string) {
  return hasValidAdminUnlock(
    req.headers.get("x-hidc-admin-unlock"),
    userId,
  );
}

export function requestHasPointAccess(req: Request, userId: string) {
  return requestHasAdminUnlock(req, userId) &&
    req.headers.get("x-hidc-show-points") === "1";
}
