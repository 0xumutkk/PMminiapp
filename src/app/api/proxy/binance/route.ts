import { NextResponse } from "next/server";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol")?.toUpperCase();

    if (!symbol) {
        return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
    }

    try {
        // 1. Handle KRW specifically via Upbit API (most common source for KRW pairs)
        if (symbol.endsWith("KRW")) {
            const base = symbol.slice(0, -3);
            const upbitSymbol = `KRW-${base}`;
            try {
                const upbitRes = await fetch(`https://api.upbit.com/v1/ticker?markets=${upbitSymbol}`, {
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
                console.error("Upbit fetch failed:", e);
            }
        }

        // 2. Try multiple Binance API endpoints for redundancy
        const endpoints = [
            `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
            `https://api1.binance.com/api/v3/ticker/price?symbol=${symbol}`,
            `https://api3.binance.com/api/v3/ticker/price?symbol=${symbol}`,
        ];

        let response;
        for (const url of endpoints) {
            try {
                response = await fetch(url, {
                    next: { revalidate: 10 }, // Cache for 10 seconds
                });
                if (response.ok) break;
            } catch (e) {
                continue;
            }
        }

        if (response && response.ok) {
            const data = await response.json();
            return NextResponse.json(data);
        }

        // 3. Fallback: If specific pair (like BTC/EUR) fails, try USDT pair as a last resort
        // but only if it's not already a USDT/USDC pair
        if (!symbol.endsWith("USDT") && !symbol.endsWith("USDC")) {
            const base = symbol.slice(0, 3); // Rough guess
            const usdtTicker = `${base}USDT`;
            const fallbackRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${usdtTicker}`, {
                next: { revalidate: 10 }
            });
            if (fallbackRes.ok) {
                const data = await fallbackRes.json();
                // Return the USD price if we couldn't get the requested quote
                return NextResponse.json(data);
            }
        }

        return NextResponse.json({ error: "Failed to fetch price from any source" }, { status: 502 });
    } catch (error) {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
