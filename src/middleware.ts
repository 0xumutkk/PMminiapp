import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// List of geo-blocked countries (ISO 3166-1 alpha-2 codes)
// Turkey (TR), Iran (IR), North Korea (KP), Syria (SY), Cuba (CU), etc.
const BLOCKED_COUNTRIES = ["TR", "IR", "KP", "SY", "CU", "CN", "AF", "RU", "BY"];
const PUBLIC_DISCOVERY_PREFIXES = ["/.well-known", "/metadata", "/meta-tags"];
const PUBLIC_DISCOVERY_API_PREFIXES = ["/api/metadata"];

function isPublicDiscoveryRoute(pathname: string) {
  if (PUBLIC_DISCOVERY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return true;
  }

  return PUBLIC_DISCOVERY_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function shouldBypassGeoBlock(pathname: string, request: NextRequest) {
  if (
    pathname.startsWith("/restricted") ||
    pathname.startsWith("/_next") ||
    pathname.includes(".") ||
    pathname === "/favicon.ico"
  ) {
    return true;
  }

  if (isPublicDiscoveryRoute(pathname)) {
    return true;
  }

  return false;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Extract country from all possible sources.
  const vGeoCountry = (request as NextRequest & { geo?: { country?: string } }).geo?.country;
  const vHeaderCountry = request.headers.get("x-vercel-ip-country");
  const cfHeaderCountry = request.headers.get("cf-ipcountry");
  const geoHeaderCountry = request.headers.get("x-geo-country");
  const country = (cfHeaderCountry || vHeaderCountry || vGeoCountry || geoHeaderCountry || "").toUpperCase();

  const isPageRequest = !pathname.includes(".") && !pathname.startsWith("/_next");
  if (isPageRequest) {
    console.log(
      `[GeoBlock] Path: ${pathname} | Final Country: ${country} | CF: ${cfHeaderCountry} | V-Header: ${vHeaderCountry} | V-Geo: ${vGeoCountry}`
    );
  }

  if (shouldBypassGeoBlock(pathname, request)) {
    return NextResponse.next();
  }

  if (country && BLOCKED_COUNTRIES.includes(country)) {
    console.log(`[GeoBlock] REDIRECTING ${country} User from ${pathname} to /restricted`);

    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Region restricted" }, { status: 403 });
    }

    const url = request.nextUrl.clone();
    url.pathname = "/restricted";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
