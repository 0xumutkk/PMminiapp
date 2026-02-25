import { claimAuthNonce, releaseAuthNonce } from "@/lib/security/auth-nonce-store";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { logEvent } from "@/lib/observability";
import {
  clearAuthCookieHeader,
  createAuthCookieHeader,
  normalizeMiniAppDomain,
  parseSiwfMessage,
  resolveExpectedAuthDomain,
  verifyMiniAppAuthToken,
  verifySiwfMessage
} from "@/lib/security/miniapp-auth";
import { isAddress } from "viem";

export const runtime = "nodejs";

type SignInBody = {
  message?: string;
  signature?: string;
};

type MessageTimingValidation =
  | { ok: false; error: string }
  | {
      ok: true;
      replayTtlMs: number;
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

function parseNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
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
  const maxAgeSeconds = parseNumberEnv("AUTH_SIWF_MAX_AGE_SECONDS", 600);
  const clockSkewSeconds = parseNumberEnv("AUTH_CLOCK_SKEW_SECONDS", 30);

  const now = Date.now();
  const maxAgeMs = maxAgeSeconds * 1_000;
  const skewMs = clockSkewSeconds * 1_000;

  const issuedAtMs = parseIsoTime(parsedMessage.issuedAt);
  if (!issuedAtMs) {
    return { ok: false, error: "SIWF message is missing a valid issuedAt value" };
  }

  if (issuedAtMs > now + skewMs) {
    return { ok: false, error: "SIWF message issuedAt is in the future" };
  }

  if (now - issuedAtMs > maxAgeMs) {
    return { ok: false, error: "SIWF message has expired by age limit" };
  }

  const notBeforeMs = parseIsoTime(parsedMessage.notBefore);
  if (notBeforeMs && now + skewMs < notBeforeMs) {
    return { ok: false, error: "SIWF message is not valid yet" };
  }

  const expirationMs = parseIsoTime(parsedMessage.expirationTime);
  if (expirationMs && now - skewMs > expirationMs) {
    return { ok: false, error: "SIWF message expirationTime has passed" };
  }

  const replayTtlMs = expirationMs ? Math.max(60_000, expirationMs - now) : maxAgeMs;

  return {
    ok: true,
    replayTtlMs
  };
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
    bucket: "auth-siwf",
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
    return badRequest("Invalid SIWF message format", requestId, rateHeaders);
  }

  if (!isAddress(parsedMessage.address)) {
    return badRequest("SIWF message contains an invalid address", requestId, rateHeaders);
  }

  if (!parsedMessage.nonce || parsedMessage.nonce.length < 8) {
    return badRequest("SIWF message nonce is missing or too short", requestId, rateHeaders);
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
    return badRequest("SIWF message domain does not match Mini App domain", requestId, rateHeaders);
  }

  const timingValidation = validateMessageTiming(parsedMessage);
  if (!timingValidation.ok) {
    return badRequest(timingValidation.error, requestId, rateHeaders);
  }

  let nonceClaimed = false;
  try {
    const domainCandidates = buildDomainCandidates(parsedMessage.domain, messageDomain, expectedDomain);
    const hostOnlyDomain = parsedMessage.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? parsedMessage.domain;
    const domainsToTry = [hostOnlyDomain, parsedMessage.domain, ...domainCandidates.map((c) => c.raw)];
    const uniqueDomains = [...new Set(domainsToTry)];

    let verifiedDomain = expectedDomain;
    let verifyResult: Awaited<ReturnType<typeof verifySiwfMessage>> | null = null;
    let verifyError: unknown = null;

    for (const domain of uniqueDomains) {
      const host = domain.replace(/^https?:\/\//, "").split("/")[0]?.trim();
      if (!host) continue;
      try {
        verifyResult = await verifySiwfMessage({
          message: body.message,
          signature: body.signature,
          domain: host,
          acceptAuthAddress: true
        });
        verifiedDomain = host;
        break;
      } catch (error) {
        verifyError = error;
      }
    }

    if (!verifyResult) {
      throw verifyError ?? new Error("SIWF verification failed");
    }

    const jwtDomainCandidates = buildDomainCandidates(
      verifiedDomain,
      parsedMessage.domain,
      expectedDomain,
      ...domainCandidates.map((candidate) => candidate.normalized)
    );
    const siwfAddress = parsedMessage.address;
    let claims = await verifyMiniAppAuthToken(
      verifyResult.token,
      verifiedDomain,
      siwfAddress
    );
    if (!claims) {
      for (const candidate of jwtDomainCandidates) {
        if (candidate.raw === verifiedDomain) {
          continue;
        }

        claims = await verifyMiniAppAuthToken(
          verifyResult.token,
          candidate.raw,
          siwfAddress
        );
        if (claims) {
          break;
        }
      }
    }

    if (!claims) {
      const headers = new Headers(rateHeaders);
      headers.set("Cache-Control", "no-store");
      for (const c of clearAuthCookieHeader()) {
        headers.append("Set-Cookie", c);
      }
      return Response.json(
        { error: "Quick Auth token verification failed", requestId },
        { status: 401, headers }
      );
    }

    if (claims.address.toLowerCase() !== parsedMessage.address.toLowerCase()) {
      const headers = new Headers(rateHeaders);
      headers.set("Cache-Control", "no-store");
      for (const c of clearAuthCookieHeader()) {
        headers.append("Set-Cookie", c);
      }
      return Response.json(
        { error: "Verified token address does not match SIWF message address", requestId },
        { status: 401, headers }
      );
    }

    nonceClaimed = await claimAuthNonce(parsedMessage.nonce, timingValidation.replayTtlMs);
    if (!nonceClaimed) {
      return Response.json(
        { error: "SIWF nonce was already used", requestId },
        {
          status: 409,
          headers: rateHeaders
        }
      );
    }

    const maxAgeSeconds = Math.max(60, claims.exp - Math.floor(Date.now() / 1_000));
    const cookieHeader = createAuthCookieHeader(
      verifyResult.token,
      maxAgeSeconds,
      claims.address
    );
    const setCookieParts = cookieHeader.split("\n").filter(Boolean);
    const headers = new Headers(rateHeaders);
    for (const part of setCookieParts) {
      headers.append("Set-Cookie", part);
    }
    headers.set("Cache-Control", "no-store");
    headers.set("X-Request-Id", requestId);

    return Response.json(
      {
        authenticated: true,
        user: {
          fid: claims.fid,
          address: claims.address,
          expiresAt: new Date(claims.exp * 1_000).toISOString()
        },
        token: verifyResult.token // Bearer fallback when cookies blocked in iframe
      },
      { headers }
    );
  } catch (error) {
    if (nonceClaimed && parsedMessage.nonce) {
      await releaseAuthNonce(parsedMessage.nonce);
    }

    const message = errorToMessage(error);
    logEvent("warn", "auth_siwf_failed", { requestId, message });
    const headers = new Headers(rateHeaders);
    headers.set("Cache-Control", "no-store");
    for (const c of clearAuthCookieHeader()) {
      headers.append("Set-Cookie", c);
    }
    return Response.json({ error: message, requestId }, { status: 401, headers });
  }
}
