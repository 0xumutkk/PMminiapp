export const runtime = "nodejs";

type AccountAssociation = {
  header: string;
  payload: string;
  signature: string;
};

type MiniAppFrameManifest = {
  version: "1";
  name: string;
  homeUrl: string;
  iconUrl: string;
  splashImageUrl: string;
  splashBackgroundColor: string;
  webhookUrl?: string;
  subtitle?: string;
  description?: string;
  screenshotUrls?: string[];
  primaryCategory?: string;
  tags?: string[];
  heroImageUrl?: string;
  tagline?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageUrl?: string;
  noindex?: boolean;
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

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : undefined;
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
}

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_MINI_APP_URL ?? "https://example.com";
  const screenshots = parseList(process.env.NEXT_PUBLIC_SCREENSHOT_URLS);
  const tags = parseList(process.env.NEXT_PUBLIC_APP_TAGS);

  const frame: MiniAppFrameManifest = {
    version: "1",
    name: process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets",
    homeUrl: baseUrl,
    iconUrl: process.env.NEXT_PUBLIC_ICON_URL ?? `${baseUrl}/icon.png`,
    splashImageUrl: process.env.NEXT_PUBLIC_SPLASH_IMAGE_URL ?? `${baseUrl}/splash.png`,
    splashBackgroundColor: process.env.NEXT_PUBLIC_SPLASH_BG ?? "#0b1020",
    webhookUrl: process.env.MINI_APP_WEBHOOK_URL || process.env.FARCASTER_WEBHOOK_URL || undefined,
    subtitle: process.env.NEXT_PUBLIC_APP_SUBTITLE || undefined,
    description: process.env.NEXT_PUBLIC_APP_DESCRIPTION || undefined,
    screenshotUrls: screenshots,
    primaryCategory: process.env.NEXT_PUBLIC_PRIMARY_CATEGORY || "finance",
    tags,
    heroImageUrl: process.env.NEXT_PUBLIC_HERO_IMAGE_URL || undefined,
    tagline: process.env.NEXT_PUBLIC_APP_TAGLINE || undefined,
    ogTitle: process.env.NEXT_PUBLIC_OG_TITLE || undefined,
    ogDescription: process.env.NEXT_PUBLIC_OG_DESCRIPTION || undefined,
    ogImageUrl: process.env.NEXT_PUBLIC_OG_IMAGE_URL || undefined,
    noindex: parseBoolean(process.env.NEXT_PUBLIC_NOINDEX)
  };

  const manifest = {
    accountAssociation: parseAccountAssociation(),
    miniapp: frame,
    frame
  };

  return Response.json(manifest, {
    headers: {
      "Cache-Control": "public, max-age=300"
    }
  });
}
