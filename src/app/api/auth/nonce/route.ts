import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rate = await checkRateLimit({
    bucket: "auth-nonce",
    request,
    limit: 60,
    windowMs: 60_000
  });

  if (!rate.ok) {
    return Response.json({ error: "Too many requests" }, { status: 429, headers: rateLimitHeaders(rate) });
  }

  const origin = process.env.FARCASTER_QUICK_AUTH_SERVER_ORIGIN ?? "https://auth.farcaster.xyz";

  const res = await fetch(`${origin}/nonce`, {
    method: "POST"
  });

  if (!res.ok) {
    return Response.json({ error: "Failed to get nonce" }, { status: 502 });
  }

  const data = (await res.json()) as { nonce?: string };
  if (!data?.nonce) {
    return Response.json({ error: "Invalid nonce response" }, { status: 502 });
  }

  return Response.json({ nonce: data.nonce }, { headers: rateLimitHeaders(rate) });
}
