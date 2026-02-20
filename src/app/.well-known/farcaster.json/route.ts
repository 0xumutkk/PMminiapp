export const runtime = "nodejs";

type AccountAssociation = {
  header: string;
  payload: string;
  signature: string;
};

function parseAccountAssociation(): AccountAssociation | undefined {
  const raw = process.env.FARCASTER_ACCOUNT_ASSOCIATION_JSON;
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AccountAssociation>;

    if (parsed.header && parsed.payload && parsed.signature) {
      return {
        header: parsed.header,
        payload: parsed.payload,
        signature: parsed.signature
      };
    }
  } catch {
    // no-op
  }

  return undefined;
}

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_MINI_APP_URL ?? "https://example.com";

  const manifest = {
    version: "1",
    name: process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets",
    iconUrl: process.env.NEXT_PUBLIC_ICON_URL ?? `${baseUrl}/icon.png`,
    homeUrl: baseUrl,
    splashImageUrl: process.env.NEXT_PUBLIC_SPLASH_IMAGE_URL ?? `${baseUrl}/splash.png`,
    splashBackgroundColor: process.env.NEXT_PUBLIC_SPLASH_BG ?? "#0b1020",
    webhookUrl: process.env.FARCASTER_WEBHOOK_URL || undefined,
    accountAssociation: parseAccountAssociation()
  };

  return Response.json(manifest, {
    headers: {
      "Cache-Control": "public, max-age=300"
    }
  });
}
