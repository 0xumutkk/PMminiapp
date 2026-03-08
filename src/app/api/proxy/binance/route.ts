import { NextResponse } from "next/server";

const FETCH_TIMEOUT_MS = 4000; // 4 seconds per attempt

async function fetchWithTimeout(url: string, options: any = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol")?.toUpperCase();

    if (!symbol) {
        return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
    }

    try {
        // 1. Upbit Fallback for KRW pairs
        if (symbol.endsWith("KRW")) {
            const base = symbol.slice(0, -3);
            const upbitSymbol = `KRW-${base}`;
            try {
                const upbitRes = await fetchWithTimeout(`https://api.upbit.com/v1/ticker?markets=${upbitSymbol}`, {
                    next: { revalidate: 10 }
                });
                if (upbitRes.ok) {
                    const upbitData = await upbitRes.json();
                    if (Array.isArray(upbitData) && upbitData.length > 0) {
                        return NextResponse.json({
                            symbol: symbol,
                            price: String(upbitData[0].trade_price)
                        });
                    }
                }
            } catch (e) {
                console.warn(`Upbit fetch failed for ${upbitSymbol}:`, e instanceof Error ? e.message : "Timeout");
            }
        }

        // 2. CoinGecko as the primary source for non-KRW or if Upbit fails
        const geckoMap: Record<string, string> = {
            "BTCKRW": "bitcoin",
            "ETHKRW": "ethereum",
            "SOLKRW": "solana",
            "BTCUSDT": "bitcoin",
            "ETHUSDT": "ethereum",
            "SOLUSDT": "solana",
            "USDCUSDT": "usd-coin",
            "LINKUSDT": "chainlink",
            "ARBUSDT": "arbitrum"
        };

        if (geckoMap[symbol]) {
            try {
                const coinId = geckoMap[symbol];
                const geckoRes = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=krw,usd`);
                if (geckoRes.ok) {
                    const data = await geckoRes.json();
                    const price = symbol.endsWith("KRW") ? data[coinId].krw : data[coinId].usd;
                    if (price) {
                        return NextResponse.json({ symbol, price: String(price) });
                    }
                }
            } catch (e) {
                console.warn("CoinGecko fetch failed:", e instanceof Error ? e.message : "Timeout");
            }
        }

        return NextResponse.json({ error: "Failed to fetch price from any source" }, { status: 502 });
    } catch (error) {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
