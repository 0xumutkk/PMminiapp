export type MarketVibe = {
    colors: string[];
    animationSpeed: number;
    label: string;
    bgImageUrl: string;
};

const VIBES: Record<string, MarketVibe> = {
    crypto: {
        colors: ["#0052ff", "#00c2ff", "#7000ff"],
        animationSpeed: 15,
        label: "Crypto",
        bgImageUrl: "/categories/crypto.webp?v=optimized",
    },
    politics: {
        colors: ["#ff003d", "#ff7a00", "#5200ff"],
        animationSpeed: 20,
        label: "Politics",
        bgImageUrl: "/categories/politics.webp?v=optimized",
    },
    sports: {
        colors: ["#0bd52d", "#00ffc2", "#0052ff"],
        animationSpeed: 12,
        label: "Sports",
        bgImageUrl: "/categories/sports.webp?v=optimized",
    },
    entertainment: {
        colors: ["#ff00f5", "#7000ff", "#00c2ff"],
        animationSpeed: 18,
        label: "Entertainment",
        bgImageUrl: "/categories/entertainment.webp?v=optimized",
    },
    science: {
        colors: ["#00f0ff", "#0052ff", "#7000ff"],
        animationSpeed: 15,
        label: "Science",
        bgImageUrl: "/categories/science.webp?v=optimized",
    },
    economy: {
        colors: ["#ffd700", "#ff7a00", "#060913"],
        animationSpeed: 20,
        label: "Economy",
        bgImageUrl: "/categories/economy.webp?v=optimized",
    },
    conspiracy: {
        colors: ["#00ffc2", "#0bd52d", "#060913"],
        animationSpeed: 25,
        label: "Conspiracy",
        bgImageUrl: "/categories/conspiracy.webp?v=optimized",
    },
    default: {
        colors: ["#0052ff", "#8eb1ff", "#060913"],
        animationSpeed: 25,
        label: "Market",
        bgImageUrl: "/categories/default.webp?v=optimized",
    },
};

export function getMarketVibe(title: string, slug?: string, categories?: string[], tags?: string[]): MarketVibe {
    const text = `${title} ${slug ?? ""}`.toLowerCase();
    const apiCats = [...(categories ?? []), ...(tags ?? [])].map(c => c.toLowerCase());

    // Helper: whole-word match to avoid "ai" inside "daily", "rain", "training", etc.
    const hasWord = (haystack: string, word: string) =>
        new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(haystack);

    // ── 0. API categories FIRST — most reliable signal ────────────────────
    if (apiCats.some(c =>
        c.includes('crypto') || c.includes('bitcoin') || c.includes('ethereum') ||
        c.includes('blockchain') || c.includes('defi') || c.includes('nft') ||
        c.includes('solana') || c.includes('web3') || c.includes('altcoin')
    )) return VIBES.crypto;

    if (apiCats.some(c =>
        c.includes('politic') || c.includes('election') || c.includes('government') ||
        c.includes('president') || c.includes('congress')
    )) return VIBES.politics;

    if (apiCats.some(c =>
        c.includes('sport') || c.includes('soccer') || c.includes('football') ||
        c.includes('nba') || c.includes('nfl') || c.includes('baseball') ||
        c.includes('tennis') || c.includes('golf') || c.includes('premier league') ||
        c.includes('off the pitch') || c.includes('recurring') || c.includes('esport')
    )) return VIBES.sports;

    if (apiCats.some(c =>
        c.includes('entertainment') || c.includes('movie') || c.includes('music') ||
        c.includes('k-pop') || c.includes('celebrity') || c.includes('film') ||
        c.includes('tv show') || c.includes('award')
    )) return VIBES.entertainment;

    if (apiCats.some(c =>
        c.includes('science') || c.includes('space') || c.includes('nasa') ||
        c.includes('physics') || c.includes('climate') || c.includes('biology') ||
        c.includes('technology') || c.includes('tech')
    )) return VIBES.science;

    // "ai" as standalone category tag only (not substring)
    if (apiCats.some(c => c === 'ai' || c === 'artificial intelligence' || c.includes('machine learning'))) return VIBES.science;

    if (apiCats.some(c =>
        c.includes('economy') || c.includes('finance') || c.includes('fed') ||
        c.includes('inflation') || c.includes('stock') || c.includes('trading')
    )) return VIBES.economy;

    if (apiCats.some(c => c.includes('conspiracy'))) return VIBES.conspiracy;

    // ── 1. Crypto coin/token name overrides ───────────────────────────────
    const cryptoCoins = [
        "bitcoin", "ethereum", "solana", "binance", " bnb", "ripple", "cardano",
        "avalanche", "chainlink", "uniswap", "dogecoin", "shiba", " btc ", " eth ",
        " sol ", "pepe coin", "altcoin"
    ];
    if (cryptoCoins.some(coin => text.includes(coin))) return VIBES.crypto;

    // Specific crypto trading context (multi-word to avoid false positives)
    const cryptoTerms = [
        "crypto market", "token price", "coin price", "market cap", "blockchain",
        "defi protocol", "nft collection", "web3", "bull run", "bear market",
        "on-chain", "wallet address", "gas fee"
    ];
    if (cryptoTerms.some(term => text.includes(term))) return VIBES.crypto;

    // ── 2. Politics keywords ──────────────────────────────────────────────
    if (
        text.includes("trump") || text.includes("biden") || text.includes("harris") ||
        text.includes("election") || text.includes("president") || text.includes("senate") ||
        text.includes("congress") || text.includes("democrat") || text.includes("republican")
    ) return VIBES.politics;

    // ── 3. Title keyword fallback (tightened — no short ambiguous words) ──
    if (
        text.includes("championship") || text.includes("match") ||
        text.includes("premier league") || text.includes("soccer") ||
        text.includes(" nba ") || text.includes(" nfl ") ||
        text.includes("liverpool") || text.includes("salah") ||
        text.includes("playoff") || text.includes("tournament") ||
        text.includes("super bowl") || text.includes("world cup") ||
        text.includes("formula 1") || text.includes("grand prix")
    ) return VIBES.sports;

    if (
        text.includes("oscar") || text.includes("grammy") ||
        text.includes("box office") || text.includes("album release") ||
        text.includes("celebrity")
    ) return VIBES.entertainment;

    // AI/Science — whole-word check for "ai", specific terms for others
    if (
        hasWord(text, "ai") ||
        text.includes("artificial intelligence") || text.includes("machine learning") ||
        text.includes("openai") || text.includes("chatgpt") || text.includes("gpt-") ||
        text.includes("nasa ") || text.includes("climate change") || text.includes("quantum")
    ) return VIBES.science;

    if (
        text.includes("inflation") || text.includes("federal reserve") ||
        text.includes("interest rate") || text.includes("recession") ||
        text.includes("dow jones") || text.includes("s&p 500") || text.includes("gdp")
    ) return VIBES.economy;

    if (text.includes("conspiracy") || text.includes("cover-up")) return VIBES.conspiracy;

    return VIBES.default;
}
