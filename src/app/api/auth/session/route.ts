import { getRequestId } from "@/lib/security/request-context";
import {
  clearAuthCookieHeader,
  getAuthAddressFromRequest,
  getAuthTokenFromRequest,
  normalizeMiniAppDomain,
  resolveExpectedAuthDomain,
  verifyMiniAppAuthToken
} from "@/lib/security/miniapp-auth";

export const runtime = "nodejs";

function parseHostCandidate(raw: string | null | undefined) {
  if (!raw) {
    return "";
  }

  const value = raw.trim();
  if (!value) {
    return "";
  }

  try {
    return new URL(value).host;
  } catch {
    if (!/^https?:\/\//i.test(value)) {
      try {
        return new URL(`https://${value}`).host;
      } catch {
        // fall through
      }
    }
  }

  return value;
}

function buildDomainCandidates(request: Request, expectedDomain: string) {
  const candidates = new Set<string>();

  const add = (raw: string | null | undefined) => {
    const parsed = parseHostCandidate(raw);
    const normalized = normalizeMiniAppDomain(parsed);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  add(expectedDomain);
  add(process.env.NEXT_PUBLIC_MINI_APP_URL);
  add(request.headers.get("x-forwarded-host")?.split(",")[0] ?? "");
  add(request.headers.get("host"));
  add(request.url);

  return [...candidates];
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const token = getAuthTokenFromRequest(request);

    if (!token) {
      return Response.json(
        { authenticated: false, requestId },
        {
          headers: {
            "Cache-Control": "no-store"
          }
        }
      );
    }

    const expectedDomain = resolveExpectedAuthDomain(request);
    const domains = buildDomainCandidates(request, expectedDomain);
    const addressFromCookie = getAuthAddressFromRequest(request);
    let claims = null;
    for (const domain of domains) {
      claims = await verifyMiniAppAuthToken(token, domain, addressFromCookie ?? undefined);
      if (claims) {
        break;
      }
    }

    if (!claims) {
      const headers = new Headers({ "Cache-Control": "no-store" });
      for (const c of clearAuthCookieHeader()) {
        headers.append("Set-Cookie", c);
      }
      return Response.json({ authenticated: false, requestId }, { headers });
    }

    return Response.json(
      {
        authenticated: true,
        user: {
          fid: claims.fid,
          address: claims.address,
          expiresAt: new Date(claims.exp * 1_000).toISOString()
        },
        token // Bearer fallback when cookies blocked in iframe
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Request-Id": requestId
        }
      }
    );
  } catch {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      "X-Session-Recovered": "true"
    });
    for (const c of clearAuthCookieHeader()) {
      headers.append("Set-Cookie", c);
    }
    return Response.json({ authenticated: false, requestId }, { headers });
  }
}

export async function DELETE() {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const c of clearAuthCookieHeader()) {
    headers.append("Set-Cookie", c);
  }
  return Response.json({ authenticated: false }, { headers });
}
