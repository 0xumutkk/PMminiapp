import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// List of geo-blocked countries (ISO 3166-1 alpha-2 codes)
// Turkey (TR), United States (US), Iran (IR), North Korea (KP), Syria (SY), Cuba (CU), etc.
const BLOCKED_COUNTRIES = ['TR', 'US', 'IR', 'KP', 'SY', 'CU', 'CN', 'AF', 'RU', 'BY'];

export function middleware(request: NextRequest) {
    const pathname = request.nextUrl.pathname;

    // 1. Extract country from all possible sources
    const vGeoCountry = (request as any).geo?.country;
    const vHeaderCountry = request.headers.get('x-vercel-ip-country');
    const cfHeaderCountry = request.headers.get('cf-ipcountry');
    const geoHeaderCountry = request.headers.get('x-geo-country'); // some other proxies

    const country = (cfHeaderCountry || vHeaderCountry || vGeoCountry || geoHeaderCountry || '').toUpperCase();

    // 2. Logging for Debug (Only for page requests to keep logs clean)
    const isPageRequest = !pathname.includes('.') && !pathname.startsWith('/_next');
    if (isPageRequest) {
        console.log(`[GeoBlock] Path: ${pathname} | Final Country: ${country} | CF: ${cfHeaderCountry} | V-Header: ${vHeaderCountry} | V-Geo: ${vGeoCountry}`);
    }

    // 3. Bypass rules
    if (
        pathname.startsWith('/restricted') ||
        pathname.startsWith('/_next') ||
        pathname.includes('.') ||
        pathname === '/favicon.ico'
    ) {
        return NextResponse.next();
    }

    // 4. Block Logic
    if (country && BLOCKED_COUNTRIES.includes(country)) {
        console.log(`[GeoBlock] REDIRECTING ${country} User from ${pathname} to /restricted`);

        // If it's an API request, return 403
        if (pathname.startsWith('/api')) {
            return NextResponse.json({ error: 'Region restricted' }, { status: 403 });
        }

        // Redirect to restricted page (URL will change in browser)
        const url = request.nextUrl.clone();
        url.pathname = '/restricted';
        return NextResponse.redirect(url);
    }

    return NextResponse.next();
}

export const config = {
    // Match all request paths except for the ones starting with:
    // - _next/static (static files)
    // - _next/image (image optimization files)
    // - favicon.ico (favicon file)
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
