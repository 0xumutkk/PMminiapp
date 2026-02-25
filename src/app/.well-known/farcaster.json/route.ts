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

function toAccountAssociation(value: unknown): AccountAssociation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<AccountAssociation>;
  if (candidate.header && candidate.payload && candidate.signature) {
    return {
      header: candidate.header,
      payload: candidate.payload,
      signature: candidate.signature
    };
  }

  return undefined;
}

function parseAccountAssociation(): AccountAssociation | undefined {
  const raw = process.env.FARCASTER_ACCOUNT_ASSOCIATION_JSON;
  if (!raw) {
    return undefined;
  }

  const candidates = [raw.trim()];
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    candidates.push(trimmed.slice(1, -1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        accountAssociation?: unknown;
        frame?: { accountAssociation?: unknown };
        miniapp?: { accountAssociation?: unknown };
      };

      const association =
        toAccountAssociation(parsed) ??
        toAccountAssociation(parsed.accountAssociation) ??
        toAccountAssociation(parsed.frame?.accountAssociation) ??
        toAccountAssociation(parsed.miniapp?.accountAssociation);

      if (association) {
        return association;
      }
    } catch {
      // try the next candidate
    }
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

function toOptionalShortText(raw: string | undefined, max = 30): string | undefined {
  if (!raw) {
    return undefined;
  }

  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }

  return value.slice(0, max);
}

function parseUrl(raw: string | undefined) {
  if (!raw) {
    return null;
  }

  const value = raw.trim();
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    if (!/^https?:\/\//i.test(value)) {
      try {
        return new URL(`https://${value}`);
      } catch {
        return null;
      }
    }

    return null;
  }
}

function isIpv4Address(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isDisallowedManifestHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost") ||
    isIpv4Address(normalized)
  );
}

function isPublicHttpsUrl(url: URL | null): url is URL {
  if (!url) {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }

  return !isDisallowedManifestHost(url.hostname);
}

function resolveBaseUrl(request: Request) {
  const requestUrl = parseUrl(request.url);
  const configuredUrl = parseUrl(process.env.NEXT_PUBLIC_MINI_APP_URL);

  if (isPublicHttpsUrl(configuredUrl)) {
    if (!requestUrl) {
      return configuredUrl.origin;
    }

    const configuredIsTunnel = configuredUrl.hostname.endsWith(".trycloudflare.com");
    if (configuredIsTunnel && configuredUrl.host !== requestUrl.host && isPublicHttpsUrl(requestUrl)) {
      return requestUrl.origin;
    }

    return configuredUrl.origin;
  }

  if (isPublicHttpsUrl(requestUrl)) {
    return requestUrl.origin;
  }

  return "https://example.com";
}

function resolveAssetUrl(
  raw: string | undefined,
  fallbackUrl: string,
  requestHost: string | undefined
) {
  const parsed = parseUrl(raw);
  if (!parsed) {
    return fallbackUrl;
  }

  if (!isPublicHttpsUrl(parsed)) {
    return fallbackUrl;
  }

  if (
    requestHost &&
    parsed.hostname.endsWith(".trycloudflare.com") &&
    parsed.host !== requestHost &&
    !isDisallowedManifestHost(requestHost)
  ) {
    return fallbackUrl;
  }

  return parsed.toString();
}

export async function GET(request: Request) {
  const baseUrl = resolveBaseUrl(request);
  const requestHost = parseUrl(request.url)?.host;
  const screenshots = parseList(process.env.NEXT_PUBLIC_SCREENSHOT_URLS);
  const tags = parseList(process.env.NEXT_PUBLIC_APP_TAGS);
  const iconUrl = resolveAssetUrl(process.env.NEXT_PUBLIC_ICON_URL, `${baseUrl}/icon.png`, requestHost);
  const splashImageUrl = resolveAssetUrl(
    process.env.NEXT_PUBLIC_SPLASH_IMAGE_URL,
    `${baseUrl}/splash.png`,
    requestHost
  );
  const ogImageUrl = resolveAssetUrl(process.env.NEXT_PUBLIC_OG_IMAGE_URL, `${baseUrl}/og.png`, requestHost);
  const heroImageUrl = resolveAssetUrl(process.env.NEXT_PUBLIC_HERO_IMAGE_URL, `${baseUrl}/og.png`, requestHost);

  const frame: MiniAppFrameManifest = {
    version: "1",
    name: (process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets").slice(0, 30),
    homeUrl: baseUrl,
    iconUrl,
    splashImageUrl,
    splashBackgroundColor: process.env.NEXT_PUBLIC_SPLASH_BG ?? "#0b1020",
    webhookUrl: process.env.MINI_APP_WEBHOOK_URL || process.env.FARCASTER_WEBHOOK_URL || undefined,
    subtitle: toOptionalShortText(process.env.NEXT_PUBLIC_APP_SUBTITLE, 30),
    description: toOptionalShortText(process.env.NEXT_PUBLIC_APP_DESCRIPTION, 30),
    screenshotUrls: screenshots,
    primaryCategory: process.env.NEXT_PUBLIC_PRIMARY_CATEGORY || "finance",
    tags,
    heroImageUrl: heroImageUrl || undefined,
    tagline: toOptionalShortText(process.env.NEXT_PUBLIC_APP_TAGLINE, 30),
    ogTitle: process.env.NEXT_PUBLIC_OG_TITLE || undefined,
    ogDescription: process.env.NEXT_PUBLIC_OG_DESCRIPTION || undefined,
    ogImageUrl: ogImageUrl || undefined,
    noindex: parseBoolean(process.env.NEXT_PUBLIC_NOINDEX)
  };

  const manifest = {
    accountAssociation: parseAccountAssociation(),
    miniapp: frame,
    frame
  };
  const cacheControl =
    process.env.NODE_ENV === "production" ? "public, max-age=300" : "no-store, max-age=0";

  return Response.json(manifest, {
    headers: {
      "Cache-Control": cacheControl
    }
  });
}
