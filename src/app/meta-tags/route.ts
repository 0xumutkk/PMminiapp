export const runtime = "nodejs";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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
    // fall through
  }

  return process.env.NEXT_PUBLIC_MINI_APP_URL ?? "https://example.com";
}

export async function GET(request: Request) {
  try {
    const origin = resolveOrigin(request);
    const appName = escapeHtml(process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets");
    const appDescription = escapeHtml(
      process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Base Mini App for live prediction markets on Base"
    );
    const ogImage = `${origin}/og.png`;

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${appName}</title>
    <meta name="description" content="${appDescription}" />
    <meta property="og:title" content="${appName}" />
    <meta property="og:description" content="${appDescription}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:url" content="${escapeHtml(origin)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${appName}" />
    <meta name="twitter:description" content="${appDescription}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
  </head>
  <body></body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("[meta-tags]", error);
    return new Response("Internal error", { status: 500 });
  }
}
