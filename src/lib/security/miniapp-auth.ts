import { isAddress } from "viem";

export const MINIAPP_AUTH_COOKIE = "miniapp_auth_token";
export const MINIAPP_AUTH_ADDRESS_COOKIE = "miniapp_auth_address";

export type MiniAppAuthClaims = {
  fid: number;
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
};

type QuickAuthClient = {
  verifyJwt: (options: { token: string; domain: string }) => Promise<unknown>;
  verifySiwf: (options: { message: string; signature: string; domain: string }) => Promise<{ token: string }>;
};

declare global {
  var __miniAppQuickAuthClientPromise: Promise<QuickAuthClient | null> | undefined;
}

async function getQuickAuthClient() {
  globalThis.__miniAppQuickAuthClientPromise ??= (async () => {
    try {
      const { createClient } = await import("@farcaster/quick-auth");
      return createClient({
        origin: process.env.FARCASTER_QUICK_AUTH_SERVER_ORIGIN
      }) as QuickAuthClient;
    } catch {
      return null;
    }
  })();

  return globalThis.__miniAppQuickAuthClientPromise;
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

function payloadToClaims(
  payload: Record<string, unknown>,
  addressFromSiwf?: string
): MiniAppAuthClaims | null {
  let address = payload.address;
  if (typeof address !== "string" || !isAddress(address)) {
    address = addressFromSiwf;
  }
  if (typeof address !== "string" || !isAddress(address)) {
    return null;
  }

  const fidRaw = payload.sub;
  const fid =
    typeof fidRaw === "number" ? fidRaw : typeof fidRaw === "string" ? Number(fidRaw) : Number.NaN;
  if (!Number.isInteger(fid) || fid <= 0) {
    return null;
  }

  const audRaw = payload.aud;
  const aud = Array.isArray(audRaw) ? audRaw[0] : audRaw;
  if (typeof aud !== "string" || aud.length === 0) {
    return null;
  }

  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0) {
    return null;
  }

  const exp = payload.exp;
  const iat = payload.iat;
  if (typeof exp !== "number" || typeof iat !== "number") {
    return null;
  }

  return {
    fid,
    address: address as `0x${string}`,
    aud,
    iss,
    exp,
    iat
  };
}

export async function verifyMiniAppAuthToken(
  token: string,
  domain: string,
  addressFromSiwf?: string
) {
  if (!token || token.length === 0 || !domain) {
    return null;
  }

  try {
    const client = await getQuickAuthClient();
    if (!client) {
      return null;
    }

    const payload = await client.verifyJwt({
      token,
      domain
    });

    return payloadToClaims(payload as Record<string, unknown>, addressFromSiwf);
  } catch {
    return null;
  }
}

export async function verifySiwfMessage(params: {
  message: string;
  signature: string;
  domain: string;
  acceptAuthAddress?: boolean;
}) {
  const { message, signature, domain, acceptAuthAddress = true } = params;
  const origin = process.env.FARCASTER_QUICK_AUTH_SERVER_ORIGIN ?? "https://auth.farcaster.xyz";

  const res = await fetch(`${origin}/verify-siwf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature, domain, acceptAuthAddress })
  });

  const data = (await res.json().catch(() => null)) as
    | { valid?: boolean; token?: string; error?: string; error_message?: string }
    | null;

  if (!res.ok) {
    const msg = data?.error_message ?? data?.error ?? `Request failed with status ${res.status}`;
    throw new Error(msg);
  }

  if (data?.valid === false) {
    throw new Error(data.error_message ?? data.error ?? "SIWF verification failed");
  }

  if (!data?.token) {
    throw new Error("No token in verification response");
  }

  return { token: data.token };
}

function shouldUseSameSiteNoneForCookies() {
  const appUrl = process.env.NEXT_PUBLIC_MINI_APP_URL ?? "";
  return (
    process.env.NODE_ENV === "production" ||
    (appUrl.startsWith("https://") && !appUrl.includes("localhost"))
  );
}

function authCookieAttributes(maxAgeSeconds: number) {
  const maxAge = Math.max(60, maxAgeSeconds);
  const useNone = shouldUseSameSiteNoneForCookies();
  const sameSite = useNone
    ? " SameSite=None;" // Required for cookies in embedded iframe (Base App)
    : " SameSite=Lax;";
  const secure = useNone || process.env.NODE_ENV === "production" ? " Secure;" : "";
  const partitioned = useNone ? " Partitioned;" : ""; // CHIPS: allows cookies in iframe when third-party cookies blocked
  return `Path=/; HttpOnly; Max-Age=${maxAge};${sameSite}${secure}${partitioned}`;
}

export function createAuthCookieHeader(
  token: string,
  maxAgeSeconds: number,
  address?: string
) {
  const attrs = authCookieAttributes(maxAgeSeconds);
  const tokenCookie = `${MINIAPP_AUTH_COOKIE}=${encodeURIComponent(token)}; ${attrs}`;
  if (address && isAddress(address)) {
    const addressCookie = `${MINIAPP_AUTH_ADDRESS_COOKIE}=${encodeURIComponent(address)}; ${attrs}`;
    return [tokenCookie, addressCookie].join("\n");
  }
  return tokenCookie;
}

export function clearAuthCookieHeader(): string[] {
  const useNone = shouldUseSameSiteNoneForCookies();
  const sameSite = useNone ? " SameSite=None;" : " SameSite=Lax;";
  const secure = useNone || process.env.NODE_ENV === "production" ? " Secure;" : "";
  const partitioned = useNone ? " Partitioned;" : "";
  const attrs = `Path=/; HttpOnly; Max-Age=0;${sameSite}${secure}${partitioned}`;
  return [
    `${MINIAPP_AUTH_COOKIE}=; ${attrs}`,
    `${MINIAPP_AUTH_ADDRESS_COOKIE}=; ${attrs}`
  ];
}

function getSiwfField(message: string, fieldName: string) {
  const prefix = `${fieldName}: `;
  const line = message
    .split("\n")
    .map((rawLine) => rawLine.trim())
    .find((lineItem) => lineItem.toLowerCase().startsWith(prefix.toLowerCase()));

  if (!line) {
    return undefined;
  }

  return line.slice(prefix.length).trim();
}

export function parseSiwfMessage(message: string): ParsedSiwfMessage | null {
  const lines = message.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const domainSuffix = " wants you to sign in with your Ethereum account:";
  const domainLine = lines[0]?.trim() ?? "";
  if (!domainLine.endsWith(domainSuffix)) {
    return null;
  }

  const domain = domainLine.slice(0, -domainSuffix.length).trim();
  const address = lines[1]?.trim() ?? "";

  if (!domain || !address) {
    return null;
  }

  return {
    domain,
    address,
    nonce: getSiwfField(message, "Nonce"),
    issuedAt: getSiwfField(message, "Issued At"),
    expirationTime: getSiwfField(message, "Expiration Time"),
    notBefore: getSiwfField(message, "Not Before")
  };
}
