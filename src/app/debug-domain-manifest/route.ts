export const runtime = "nodejs";

function resolveOrigin(request: Request): string {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    const host = forwardedHost.split(",")[0]?.trim() ?? "";
    if (host) {
      const proto = forwardedProto === "https" ? "https" : "http";
      return `${proto}://${host}`;
    }
  }

  try {
    const url = request.url;
    if (url && typeof url === "string") {
      return new URL(url).origin;
    }
  } catch {
    // fall through to fallback
  }

  return "https://example.com";
}

export async function GET(request: Request) {
  try {
    const origin = resolveOrigin(request);
    const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets";
    const appDescription =
      process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Base Mini App for live prediction markets on Base";

    return Response.json(
      {
        name: appName,
        description: appDescription,
        homeUrl: origin,
        iconUrl: `${origin}/icon.png`,
        splashImageUrl: `${origin}/splash.png`,
        ogImageUrl: `${origin}/og.png`
      },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    console.error("[debug-domain-manifest]", error);
    return Response.json(
      { error: "Internal error", message: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
