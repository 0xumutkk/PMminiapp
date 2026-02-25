import { fetchPublicPortfolioPositions } from "@/lib/portfolio/limitless-portfolio";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { isAddress } from "viem";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = getRequestId(request);

  const rate = await checkRateLimit({
    bucket: "portfolio-positions",
    request,
    limit: 120,
    windowMs: 60_000
  });
  const headers = new Headers(rateLimitHeaders(rate));
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);

  if (!rate.ok) {
    return Response.json(
      {
        error: "Too many requests",
        requestId
      },
      {
        status: 429,
        headers
      }
    );
  }

  const url = new URL(request.url);
  const account = url.searchParams.get("account")?.trim() ?? "";

  if (!isAddress(account)) {
    return Response.json(
      {
        error: "account query param must be a valid EVM address",
        requestId
      },
      {
        status: 400,
        headers
      }
    );
  }

  try {
    const snapshot = await fetchPublicPortfolioPositions(account);
    return Response.json(snapshot, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Portfolio positions lookup failed";
    return Response.json(
      {
        error: message,
        requestId
      },
      {
        status: 502,
        headers
      }
    );
  }
}
