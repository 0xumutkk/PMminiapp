import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";
import { parseSiweMessage as parseRawSiweMessage } from "viem/siwe";

export const MINIAPP_AUTH_COOKIE = "miniapp_auth_token";
export const MINIAPP_AUTH_ADDRESS_COOKIE = "miniapp_auth_address";
export const MINIAPP_AUTH_DOMAIN_COOKIE = "miniapp_auth_domain";
export const MINIAPP_AUTH_NONCE_COOKIE = "miniapp_auth_nonce";

const AUTH_TOKEN_ISSUER = "base-standard-web-app";

export type MiniAppAuthClaims = {
  address: `0x${string}`;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
};

export type ParsedSiwfMessage = {
  domain: string;
  address: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  chainId?: number;
  uri?: string;
  version?: string;
  statement?: string;
};

declare global {
  var __miniAppAuthSessionSecret: string | undefined;
}

function getSessionSecret() {
  const configured = process.env.AUTH_SESSION_SECRET?.trim();
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET is required in production");
  }

  globalThis.__miniAppAuthSessionSecret ??= randomBytes(32).toString("hex");
  return globalThis.__miniAppAuthSessionSecret;
}

function encodeJsonBase64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJsonBase64Url<T>(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function signToken(input: string) {
  return createHmac("sha256", getSessionSecret()).update(input).digest();
}

export function normalizeMiniAppDomain(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function parseHostFromUrl(raw: string | undefined) {
  if (!raw) {
    return "";
  }

  const value = raw.trim();
  if (!value) {
    return "";
  }

  try {
    return new URL(value).host.toLowerCase();
  } catch {
    if (!/^https?:\/\//i.test(value)) {
      try {
        return new URL(`https://${value}`).host.toLowerCase();
      } catch {
        // fall through
      }
    }

    return normalizeMiniAppDomain(value);
  }
}

export function resolveExpectedAuthDomain(request: Request) {
  const configuredHost = parseHostFromUrl(process.env.NEXT_PUBLIC_MINI_APP_URL);
  if (configuredHost) {
    return configuredHost;
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const firstHost = forwardedHost.split(",")[0]?.trim();
    if (firstHost) {
      return normalizeMiniAppDomain(firstHost);
    }
  }

  try {
    return normalizeMiniAppDomain(new URL(request.url).host);
  } catch {
    return "";
  }
}

function parseCookieHeader(raw: string | null) {
  const cookies = new Map<string, string>();
  if (!raw) {
    return cookies;
  }

  for (const entry of raw.split(";")) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) {
      continue;
    }

    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }

  return cookies;
}

function parseBearerToken(authorization: string | null) {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token.trim();
}

export function getAuthTokenFromRequest(request: Request) {
  const bearerToken = parseBearerToken(request.headers.get("authorization"));
  if (bearerToken) {
    return bearerToken;
  }

  const cookies = parseCookieHeader(request.headers.get("cookie"));
  return cookies.get(MINIAPP_AUTH_COOKIE) ?? null;
}

export function getAuthAddressFromRequest(request: Request) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  return cookies.get(MINIAPP_AUTH_ADDRESS_COOKIE) ?? null;
}

export function getAuthDomainFromRequest(request: Request) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const raw = cookies.get(MINIAPP_AUTH_DOMAIN_COOKIE) ?? "";
  const normalized = normalizeMiniAppDomain(raw);
  return normalized || null;
}

export function getAuthNonceFromRequest(request: Request) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  return cookies.get(MINIAPP_AUTH_NONCE_COOKIE) ?? null;
}

export function createMiniAppAuthToken(params: {
  address: `0x${string}`;
  domain: string;
  maxAgeSeconds: number;
}) {
  const now = Math.floor(Date.now() / 1_000);
  const claims: MiniAppAuthClaims = {
    address: params.address,
    aud: normalizeMiniAppDomain(params.domain),
    iss: AUTH_TOKEN_ISSUER,
    iat: now,
    exp: now + Math.max(60, params.maxAgeSeconds)
  };

  const header = encodeJsonBase64Url({ alg: "HS256", typ: "JWT" });
  const payload = encodeJsonBase64Url(claims);
  const input = `${header}.${payload}`;
  const signature = signToken(input).toString("base64url");

  return {
    token: `${input}.${signature}`,
    claims
  };
}

export async function verifyMiniAppAuthToken(
  token: string,
  domain: string,
  expectedAddress?: string
) {
  if (!token || token.length === 0 || !domain) {
    return null;
  }

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      return null;
    }

    const header = decodeJsonBase64Url<{ alg?: string; typ?: string }>(encodedHeader);
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return null;
    }

    const actualSignature = Buffer.from(encodedSignature, "base64url");
    const expectedSignature = signToken(`${encodedHeader}.${encodedPayload}`);

    if (actualSignature.length !== expectedSignature.length) {
      return null;
    }

    if (!timingSafeEqual(actualSignature, expectedSignature)) {
      return null;
    }

    const claims = decodeJsonBase64Url<MiniAppAuthClaims>(encodedPayload);
    if (!claims || claims.iss !== AUTH_TOKEN_ISSUER) {
      return null;
    }

    if (!isAddress(claims.address)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1_000);
    if (!Number.isFinite(claims.exp) || claims.exp <= now) {
      return null;
    }

    if (normalizeMiniAppDomain(domain) !== claims.aud) {
      return null;
    }

    if (expectedAddress && isAddress(expectedAddress)) {
      if (claims.address.toLowerCase() !== expectedAddress.toLowerCase()) {
        return null;
      }
    }

    return claims;
  } catch {
    return null;
  }
}

function shouldUseSecureCookies() {
  const appUrl = process.env.NEXT_PUBLIC_MINI_APP_URL ?? "";
  return (
    process.env.NODE_ENV === "production" ||
    (appUrl.startsWith("https://") && !appUrl.includes("localhost"))
  );
}

function cookieAttributes(maxAgeSeconds: number, httpOnly = true) {
  const maxAge = Math.max(60, maxAgeSeconds);
  const secure = shouldUseSecureCookies() ? " Secure;" : "";
  const httpOnlyAttr = httpOnly ? " HttpOnly;" : "";
  return `Path=/; Max-Age=${maxAge}; SameSite=Lax;${secure}${httpOnlyAttr}`;
}

export function createAuthCookieHeader(
  token: string,
  maxAgeSeconds: number,
  address?: string,
  verifiedDomain?: string
) {
  const attrs = cookieAttributes(maxAgeSeconds);
  const tokenCookie = `${MINIAPP_AUTH_COOKIE}=${encodeURIComponent(token)}; ${attrs}`;
  const normalizedDomain = normalizeMiniAppDomain(verifiedDomain ?? "");
  const domainCookie = normalizedDomain
    ? `${MINIAPP_AUTH_DOMAIN_COOKIE}=${encodeURIComponent(normalizedDomain)}; ${attrs}`
    : null;

  if (address && isAddress(address)) {
    const addressCookie = `${MINIAPP_AUTH_ADDRESS_COOKIE}=${encodeURIComponent(address)}; ${attrs}`;
    return [tokenCookie, addressCookie, domainCookie].filter(Boolean).join("\n");
  }

  return [tokenCookie, domainCookie].filter(Boolean).join("\n");
}

export function createNonceCookieHeader(nonce: string, maxAgeSeconds: number) {
  const attrs = cookieAttributes(maxAgeSeconds);
  return `${MINIAPP_AUTH_NONCE_COOKIE}=${encodeURIComponent(nonce)}; ${attrs}`;
}

export function clearAuthCookieHeader(): string[] {
  const secure = shouldUseSecureCookies() ? " Secure;" : "";
  const attrs = `Path=/; Max-Age=0; SameSite=Lax;${secure} HttpOnly;`;
  return [
    `${MINIAPP_AUTH_COOKIE}=; ${attrs}`,
    `${MINIAPP_AUTH_ADDRESS_COOKIE}=; ${attrs}`,
    `${MINIAPP_AUTH_DOMAIN_COOKIE}=; ${attrs}`
  ];
}

export function clearNonceCookieHeader() {
  const secure = shouldUseSecureCookies() ? " Secure;" : "";
  return `${MINIAPP_AUTH_NONCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax;${secure} HttpOnly;`;
}

export function parseSiwfMessage(message: string): ParsedSiwfMessage | null {
  try {
    const parsed = parseRawSiweMessage(message);
    if (!parsed.domain || !parsed.address) {
      return null;
    }

    return {
      domain: parsed.domain,
      address: parsed.address,
      nonce: parsed.nonce,
      issuedAt: parsed.issuedAt?.toISOString(),
      expirationTime: parsed.expirationTime?.toISOString(),
      notBefore: parsed.notBefore?.toISOString(),
      chainId: parsed.chainId,
      uri: parsed.uri,
      version: parsed.version,
      statement: parsed.statement
    };
  } catch {
    return null;
  }
}
