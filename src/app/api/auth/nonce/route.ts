import { generateSiweNonce } from "viem/siwe";
import {
  clearNonceCookieHeader,
  createNonceCookieHeader
} from "@/lib/security/miniapp-auth";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const NONCE_MAX_AGE_SECONDS = 10 * 60;

export async function POST(request: Request) {
  const rate = await checkRateLimit({
    bucket: "auth-nonce",
    request,
    limit: 60,
    windowMs: 60_000
  });

  const headers = new Headers(rateLimitHeaders(rate));
  headers.set("Cache-Control", "no-store");

  if (!rate.ok) {
    return Response.json({ error: "Too many requests" }, { status: 429, headers });
  }

  const nonce = generateSiweNonce();
  headers.append("Set-Cookie", clearNonceCookieHeader());
  headers.append("Set-Cookie", createNonceCookieHeader(nonce, NONCE_MAX_AGE_SECONDS));

  return Response.json({ nonce }, { headers });
}
