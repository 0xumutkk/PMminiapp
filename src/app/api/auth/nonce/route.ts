import { generateSiweNonce } from "viem/siwe";
import {
  clearNonceCookieHeader,
  createNonceCookieHeader
} from "@/lib/security/miniapp-auth";
import { issueAuthNonce } from "@/lib/security/auth-nonce-store";
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

  let nonce = "";
  let issued = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    nonce = generateSiweNonce();
    issued = await issueAuthNonce(nonce, NONCE_MAX_AGE_SECONDS * 1_000);
    if (issued) {
      break;
    }
  }

  if (!issued || !nonce) {
    return Response.json({ error: "Failed to issue sign-in nonce" }, { status: 500, headers });
  }

  headers.append("Set-Cookie", clearNonceCookieHeader());
  headers.append("Set-Cookie", createNonceCookieHeader(nonce, NONCE_MAX_AGE_SECONDS));

  return Response.json({ nonce }, { headers });
}
