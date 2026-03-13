import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { logEvent } from "@/lib/observability";
import {
  clearAuthCookieHeader,
  clearNonceCookieHeader,
  createAuthCookieHeader,
  createMiniAppAuthToken,
  getAuthNonceFromRequest,
  normalizeMiniAppDomain,
  parseSiwfMessage,
  resolveExpectedAuthDomain
} from "@/lib/security/miniapp-auth";
import { createPublicClient, http, isAddress } from "viem";
import { base } from "viem/chains";

export const runtime = "nodejs";

type SignInBody = {
  message?: string;
  signature?: string;
};

type MessageTimingValidation =
  | { ok: false; error: string }
  | {
      ok: true;
    };

type DomainValidationCandidate = {
  raw: string;
  normalized: string;
};

function errorToMessage(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) {
      return record.message;
    }

    if (typeof record.error_message === "string" && record.error_message.length > 0) {
      return record.error_message;
    }
  }

  return "Authentication failed";
}

function parseNumberEnv(names: string[], fallback: number) {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) {
      continue;
    }

    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return fallback;
}

function parseIsoTime(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateMessageTiming(parsedMessage: {
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
}): MessageTimingValidation {
  const maxAgeSeconds = parseNumberEnv(["AUTH_SIWE_MAX_AGE_SECONDS", "AUTH_SIWF_MAX_AGE_SECONDS"], 600);
  const clockSkewSeconds = parseNumberEnv(["AUTH_CLOCK_SKEW_SECONDS"], 30);

  const now = Date.now();
  const maxAgeMs = maxAgeSeconds * 1_000;
  const skewMs = clockSkewSeconds * 1_000;

  const issuedAtMs = parseIsoTime(parsedMessage.issuedAt);
  if (!issuedAtMs) {
    return { ok: false, error: "SIWE message is missing a valid issuedAt value" };
  }

  if (issuedAtMs > now + skewMs) {
    return { ok: false, error: "SIWE message issuedAt is in the future" };
  }

  if (now - issuedAtMs > maxAgeMs) {
    return { ok: false, error: "SIWE message has expired by age limit" };
  }

  const notBeforeMs = parseIsoTime(parsedMessage.notBefore);
  if (notBeforeMs && now + skewMs < notBeforeMs) {
    return { ok: false, error: "SIWE message is not valid yet" };
  }

  const expirationMs = parseIsoTime(parsedMessage.expirationTime);
  if (expirationMs && now - skewMs > expirationMs) {
    return { ok: false, error: "SIWE message expirationTime has passed" };
  }

  return { ok: true };
}

function badRequest(message: string, requestId: string, headers: Record<string, string>) {
  return Response.json(
    { error: message, requestId },
    {
      status: 400,
      headers
    }
  );
}

function tryParseUrl(raw: string) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function toDomainForms(raw: string) {
  const forms = new Set<string>();
  const value = raw.trim();
  if (!value) {
    return [];
  }

  forms.add(value);

  const parsed = tryParseUrl(value);
  if (parsed) {
    forms.add(parsed.origin);
    forms.add(parsed.host);
    return [...forms];
  }

  if (!/^https?:\/\//i.test(value)) {
    const synthetic = tryParseUrl(`https://${value}`);
    if (synthetic) {
      forms.add(synthetic.origin);
      forms.add(synthetic.host);
    }
  }

  return [...forms];
}

function buildDomainCandidates(...values: Array<string | undefined>): DomainValidationCandidate[] {
  const candidates: DomainValidationCandidate[] = [];
  const seenRaw = new Set<string>();

  for (const value of values) {
    for (const form of toDomainForms(value ?? "")) {
      const normalized = normalizeMiniAppDomain(form);
      if (!normalized) {
        continue;
      }

      const raw = form.trim();
      if (!raw || seenRaw.has(raw)) {
        continue;
      }

      seenRaw.add(raw);
      candidates.push({ raw, normalized });
    }
  }

  return candidates;
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  const rate = await checkRateLimit({
    bucket: "auth-siwe",
    request,
    limit: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? "30"),
    windowMs: 60_000
  });
  const rateHeaders = rateLimitHeaders(rate);

  if (!rate.ok) {
    return Response.json(
      { error: "Too many authentication requests", requestId },
      {
        status: 429,
        headers: rateHeaders
      }
    );
  }

  let body: SignInBody;
  try {
    body = (await request.json()) as SignInBody;
  } catch {
    return badRequest("Invalid JSON body", requestId, rateHeaders);
  }

  if (!body.message || typeof body.message !== "string") {
    return badRequest("message is required", requestId, rateHeaders);
  }

  if (!body.signature || typeof body.signature !== "string") {
    return badRequest("signature is required", requestId, rateHeaders);
  }

  const parsedMessage = parseSiwfMessage(body.message);
  if (!parsedMessage) {
    return badRequest("Invalid SIWE message format", requestId, rateHeaders);
  }

  if (!isAddress(parsedMessage.address)) {
    return badRequest("SIWE message contains an invalid address", requestId, rateHeaders);
  }

  if (!parsedMessage.nonce || parsedMessage.nonce.length < 8) {
    return badRequest("SIWE message nonce is missing or too short", requestId, rateHeaders);
  }

  const nonceFromCookie = getAuthNonceFromRequest(request);
  if (!nonceFromCookie || nonceFromCookie !== parsedMessage.nonce) {
    return badRequest("SIWE nonce does not match the current sign-in session", requestId, rateHeaders);
  }

  const expectedDomain = resolveExpectedAuthDomain(request);
  if (!expectedDomain) {
    return badRequest("Auth domain could not be resolved", requestId, rateHeaders);
  }

  const messageDomain = normalizeMiniAppDomain(parsedMessage.domain);
  const expectedDomainCandidates = buildDomainCandidates(
    expectedDomain,
    process.env.NEXT_PUBLIC_MINI_APP_URL,
    request.headers.get("x-forwarded-host")?.split(",")[0] ?? "",
    request.headers.get("host") ?? "",
    request.url
  );
  const allowedDomains = new Set(expectedDomainCandidates.map((candidate) => candidate.normalized));

  if (!allowedDomains.has(messageDomain)) {
    return badRequest("SIWE message domain does not match app domain", requestId, rateHeaders);
  }

  const timingValidation = validateMessageTiming(parsedMessage);
  if (!timingValidation.ok) {
    return badRequest(timingValidation.error, requestId, rateHeaders);
  }

  try {
    const rpcUrl = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";
    const publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl)
    });

    const verified = await publicClient.verifySiweMessage({
      address: parsedMessage.address as `0x${string}`,
      domain: messageDomain,
      message: body.message,
      nonce: nonceFromCookie,
      signature: body.signature as `0x${string}`,
      time: new Date()
    });

    if (!verified) {
      throw new Error("SIWE verification failed");
    }

    const sessionMaxAgeSeconds = parseNumberEnv(["AUTH_SESSION_MAX_AGE_SECONDS"], 60 * 60 * 24 * 7);
    const { token, claims } = createMiniAppAuthToken({
      address: parsedMessage.address as `0x${string}`,
      domain: messageDomain,
      maxAgeSeconds: sessionMaxAgeSeconds
    });

    const cookieHeader = createAuthCookieHeader(
      token,
      sessionMaxAgeSeconds,
      claims.address,
      messageDomain
    );

    const headers = new Headers(rateHeaders);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Request-Id", requestId);
    for (const cookie of cookieHeader.split("\n")) {
      headers.append("Set-Cookie", cookie);
    }
    headers.append("Set-Cookie", clearNonceCookieHeader());

    return Response.json(
      {
        authenticated: true,
        user: {
          address: claims.address,
          expiresAt: new Date(claims.exp * 1_000).toISOString()
        },
        token
      },
      { headers }
    );
  } catch (error) {
    const message = errorToMessage(error);
    logEvent("warn", "auth_siwe_failed", { requestId, message });

    const headers = new Headers(rateHeaders);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Request-Id", requestId);
    for (const cookie of clearAuthCookieHeader()) {
      headers.append("Set-Cookie", cookie);
    }
    headers.append("Set-Cookie", clearNonceCookieHeader());

    return Response.json({ error: message, requestId }, { status: 401, headers });
  }
}
