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
        bgImageUrl: "/categories/crypto.png",
    },
    politics: {
        colors: ["#ff003d", "#ff7a00", "#5200ff"],
        animationSpeed: 20,
        label: "Politics",
        bgImageUrl: "/categories/politics.png",
    },
    sports: {
        colors: ["#0bd52d", "#00ffc2", "#0052ff"],
        animationSpeed: 12,
        label: "Sports",
        bgImageUrl: "/categories/sports.png",
    },
    entertainment: {
        colors: ["#ff00f5", "#7000ff", "#00c2ff"],
        animationSpeed: 18,
        label: "Entertainment",
        bgImageUrl: "/categories/entertainment.png",
    },
    science: {
        colors: ["#00f0ff", "#0052ff", "#7000ff"],
        animationSpeed: 15,
        label: "Science",
        bgImageUrl: "/categories/science.png",
    },
    economy: {
        colors: ["#ffd700", "#ff7a00", "#060913"],
        animationSpeed: 20,
        label: "Economy",
        bgImageUrl: "/categories/economy.png",
    },
    conspiracy: {
        colors: ["#00ffc2", "#0bd52d", "#060913"],
        animationSpeed: 25,
        label: "Conspiracy",
        bgImageUrl: "/categories/conspiracy.png",
    },
    default: {
        colors: ["#0052ff", "#8eb1ff", "#060913"],
        animationSpeed: 25,
        label: "Market",
        bgImageUrl: "/categories/default.png",
    },
};

export function getMarketVibe(title: string, slug?: string, categories?: string[], tags?: string[]): MarketVibe {
    const text = `${title} ${slug ?? ""}`.toLowerCase();
    const apiCats = [...(categories ?? []), ...(tags ?? [])].map(c => c.toLowerCase());

    // 0. Strong Priority Keywords (Override API mistakes)
    if (text.includes("binance") || text.includes("bitcoin") || text.includes("eth") || text.includes("solana") || text.includes("price") || text.includes("above") || text.includes("below") || text.includes("$")) {
        return VIBES.crypto;
    }
    if (text.includes("trump") || text.includes("election") || text.includes("biden") || text.includes("harris")) {
        return VIBES.politics;
    }

    // 1. Try mapping from API categories/tags
    if (apiCats.some(c => c.includes('crypto') || c.includes('bitcoin') || c.includes('ethereum') || c.includes('blockchain'))) return VIBES.crypto;
    if (apiCats.some(c => c.includes('politics') || c.includes('election'))) return VIBES.politics;
    if (apiCats.some(c => c.includes('sport') || c.includes('soccer') || c.includes('football') || c.includes('nba') || c.includes('premier league') || c.includes('off the pitch') || c.includes('recurring'))) return VIBES.sports;
    if (apiCats.some(c => c.includes('entertainment') || c.includes('movie') || c.includes('music') || c.includes('k-pop'))) return VIBES.entertainment;
    if (apiCats.some(c => c.includes('science') || c.includes('ai') || c.includes('space'))) return VIBES.science;
    if (apiCats.some(c => c.includes('economy') || c.includes('fed') || c.includes('inflation'))) return VIBES.economy;
    if (apiCats.some(c => c.includes('conspiracy'))) return VIBES.conspiracy;

    // 2. Fallback to keyword matching in title/slug (Remaining)
    if (text.includes("win") || text.includes("game") || text.includes("match") || text.includes("league") || text.includes("sports") || text.includes("football") || text.includes("soccer") || text.includes("nba") || text.includes("liverpool") || text.includes("salah")) {
        return VIBES.sports;
    }
    if (text.includes("oscar") || text.includes("movie") || text.includes("entertainment") || text.includes("award") || text.includes("music")) {
        return VIBES.entertainment;
    }
    if (text.includes("science") || text.includes("nasa") || text.includes("ai") || text.includes("space")) {
        return VIBES.science;
    }
    if (text.includes("inflation") || text.includes("economy") || text.includes("fed") || text.includes("rate")) {
        return VIBES.economy;
    }
    if (text.includes("conspiracy") || text.includes("secret") || text.includes("cover-up")) {
        return VIBES.conspiracy;
    }

    return VIBES.default;
}
