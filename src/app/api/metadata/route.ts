export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

function resolveOrigin(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost.split(",")[0]?.trim()}`;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return "https://example.com";
  }
}

export async function GET(request: Request) {
  const origin = resolveOrigin(request);
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets";
  const appDescription =
    process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Base Mini App for live prediction markets on Base";

  return Response.json(
    {
      title: appName,
      description: appDescription,
      url: origin,
      image: `${origin}/og.png`
    },
    {
      headers: {
        "Cache-Control": "no-store",
        ...corsHeaders
      }
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}
