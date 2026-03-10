import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// List of geo-blocked countries (ISO 3166-1 alpha-2 codes)
// Turkey (TR), United States (US), Iran (IR), North Korea (KP), Syria (SY), Cuba (CU), etc.
const BLOCKED_COUNTRIES = ['TR', 'US', 'IR', 'KP', 'SY', 'CU', 'CN', 'AF', 'RU', 'BY'];

export function middleware(request: NextRequest) {
    // Extract country from Next.js auto-populated geo object or common headers
    const vGeoCountry = (request as any).geo?.country;
    const vHeaderCountry = request.headers.get('x-vercel-ip-country');
    const cfHeaderCountry = request.headers.get('cf-ipcountry');

    const pathname = request.nextUrl.pathname;
    const country = vGeoCountry || vHeaderCountry || cfHeaderCountry || '';

    console.log(`[Middleware] Path: ${pathname} | Country: ${country} | Sources: vGeo=${vGeoCountry}, vHeader=${vHeaderCountry}, cfHeader=${cfHeaderCountry}`);

    // We don't want to block the restricted page itself or static assets
    if (
        pathname.startsWith('/restricted') ||
        pathname.includes('.') || // static files usually have extension
        pathname.startsWith('/_next')
    ) {
        return NextResponse.next();
    }

    if (country && BLOCKED_COUNTRIES.includes(country)) {
        // If it's an API request, return a 403 Forbidden JSON response
        if (pathname.startsWith('/api')) {
            return NextResponse.json(
                { error: 'Service unavailable in your region.' },
                { status: 403 }
            );
        }
        // Redirect to a specific "restricted" page
        request.nextUrl.pathname = '/restricted';
        return NextResponse.rewrite(request.nextUrl);
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
