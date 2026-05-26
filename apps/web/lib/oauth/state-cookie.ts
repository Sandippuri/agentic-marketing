import { cookies } from "next/headers";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Short-lived signed cookie that carries OAuth state across the provider
// round-trip. We pack workspaceId + returnTo + PKCE verifier + random nonce
// into the value, sign it, and verify on callback. The `state` query param
// sent to the provider is the nonce; the cookie is the binding.

const COOKIE_NAME = "oauth_state";
const COOKIE_MAX_AGE_SEC = 600; // 10 minutes

export type OAuthStatePayload = {
  workspaceId: string;
  provider: string;
  nonce: string;
  returnTo: string;
  codeVerifier?: string;
};

function getSecret(): Buffer {
  const s =
    process.env.SOCIAL_TOKEN_ENC_KEY ?? process.env.SUPABASE_JWT_SECRET ?? "";
  if (!s) {
    throw new Error(
      "OAuth state cookie needs SOCIAL_TOKEN_ENC_KEY (preferred) or SUPABASE_JWT_SECRET",
    );
  }
  return Buffer.from(s, "utf8");
}

function sign(payload: string): string {
  const mac = createHmac("sha256", getSecret()).update(payload).digest();
  return mac.toString("base64url");
}

function pack(payload: OAuthStatePayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  return `${b64}.${sign(b64)}`;
}

function unpack(value: string): OAuthStatePayload | null {
  const [b64, mac] = value.split(".");
  if (!b64 || !mac) return null;
  const expected = sign(b64);
  const a = Buffer.from(mac, "base64url");
  const b = Buffer.from(expected, "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function setStateCookie(
  payload: Omit<OAuthStatePayload, "nonce"> & { nonce?: string },
): Promise<string> {
  const nonce = payload.nonce ?? randomBytes(16).toString("hex");
  const full: OAuthStatePayload = { ...payload, nonce };
  const value = pack(full);
  const jar = await cookies();
  jar.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
  });
  return nonce;
}

export async function readStateCookie(
  expectedNonce: string,
): Promise<OAuthStatePayload | null> {
  const jar = await cookies();
  const c = jar.get(COOKIE_NAME);
  if (!c) return null;
  const payload = unpack(c.value);
  if (!payload) return null;
  if (payload.nonce !== expectedNonce) return null;
  return payload;
}

export async function clearStateCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}
