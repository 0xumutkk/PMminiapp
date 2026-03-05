"use client";

import { useState, useEffect } from "react";

const BASE_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "USDT", "USDC", "LINK"];
const QUOTE_SYMBOLS = ["USDT", "USDC", "USD", "EUR", "GBP", "TRY", "BRL", "JPY", "KRW"];

const priceCache: Record<string, { price: number; timestamp: number }> = {};
const CACHE_TTL_MS = 10_000; // 10 seconds

async function fetchBinancePrice(base: string, quote: string): Promise<number | null> {
    // Normalize quote for Binance (USD -> USDT)
    let normalizedQuote = quote.toUpperCase();
    if (normalizedQuote === "USD") normalizedQuote = "USDT";

    const ticker = `${base.toUpperCase()}${normalizedQuote}`;
    const cacheKey = ticker;

    // Check cache
    const cached = priceCache[cacheKey];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.price;
    }

    try {
        // Use our internal proxy to avoid CORS/Load failed issues in the browser
        const response = await fetch(`/api/proxy/binance?symbol=${ticker}`);
        if (!response.ok) {
            // If direct pair fails (like KRW on Binance), try to fetch USDT and convert or just return null
            return null;
        }
        const data = await response.json();
        const price = parseFloat(data.price);

        if (!isNaN(price)) {
            priceCache[cacheKey] = { price, timestamp: Date.now() };
            return price;
        }
    } catch (e) {
        console.error(`Failed to fetch price for ${ticker}:`, e);
    }
    return null;
}

export function useTokenPrice(title: string, categoryId: string) {
    const [priceData, setPriceData] = useState<{ base: string; quote: string; price: number | null }>({
        base: "",
        quote: "",
        price: null,
    });

    useEffect(() => {
        if (categoryId !== "crypto") return;

        let base = "";
        let quote = "USD"; // Default

        const upperTitle = title.toUpperCase();

        // 1. Try to detect explicit "BASE/QUOTE" or "BASE-QUOTE" pattern first
        const pairMatch = upperTitle.match(/\b([A-Z0-9]+)[\/\-]([A-Z0-9]+)\b/);
        if (pairMatch) {
            const detectedBase = pairMatch[1];
            const detectedQuote = pairMatch[2];

            if (BASE_SYMBOLS.includes(detectedBase) || detectedBase === "USDT" || detectedBase === "USDC") {
                base = detectedBase;
                if (QUOTE_SYMBOLS.includes(detectedQuote)) {
                    quote = detectedQuote;
                }
            }
        }

        // 2. Fallback to independent search if pair not found or invalid
        if (!base) {
            for (const sym of BASE_SYMBOLS) {
                if (new RegExp(`\\b${sym}\\b`, 'i').test(upperTitle)) {
                    base = sym;
                    break;
                }
            }

            if (!base) {
                if (/\bBITCOIN\b/i.test(upperTitle)) base = "BTC";
                else if (/\bETHEREUM\b/i.test(upperTitle)) base = "ETH";
                else if (/\bSOLANA\b/i.test(upperTitle)) base = "SOL";
                else if (/\bTETHER\b/i.test(upperTitle)) base = "USDT";
            }
        }

        if (!base) return;

        // 3. Look for quote if not already found in pair match
        if (quote === "USD") {
            for (const q of QUOTE_SYMBOLS) {
                // Don't pick the same as base if searching independently
                if (q === base) continue;
                if (new RegExp(`\\b${q}\\b`, 'i').test(upperTitle)) {
                    quote = q;
                    break;
                }
            }
        }

        let cancelled = false;

        const updatePrice = async () => {
            const price = await fetchBinancePrice(base, quote);
            if (!cancelled) {
                setPriceData({ base, quote, price });
            }
        };

        updatePrice();
        const interval = setInterval(updatePrice, CACHE_TTL_MS);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [title, categoryId]);

    return priceData;
}
