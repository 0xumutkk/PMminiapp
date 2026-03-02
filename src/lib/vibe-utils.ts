export type MarketVibe = {
    colors: string[];
    animationSpeed: number;
    label: string;
};

const VIBES: Record<string, MarketVibe> = {
    crypto: {
        colors: ["#0052ff", "#00c2ff", "#7000ff"],
        animationSpeed: 15,
        label: "Crypto",
    },
    politics: {
        colors: ["#ff003d", "#ff7a00", "#5200ff"],
        animationSpeed: 20,
        label: "Politics",
    },
    sports: {
        colors: ["#0bd52d", "#00ffc2", "#0052ff"],
        animationSpeed: 12,
        label: "Sports",
    },
    entertainment: {
        colors: ["#ff00f5", "#7000ff", "#00c2ff"],
        animationSpeed: 18,
        label: "Entertainment",
    },
    default: {
        colors: ["#0052ff", "#8eb1ff", "#060913"],
        animationSpeed: 25,
        label: "Market",
    },
};

export function getMarketVibe(title: string, slug?: string, categories?: string[], tags?: string[]): MarketVibe {
    const text = `${title} ${slug ?? ""}`.toLowerCase();
    const apiCats = [...(categories ?? []), ...(tags ?? [])].map(c => c.toLowerCase());

    // 1. Try mapping from API categories/tags first
    if (apiCats.some(c => c.includes('crypto') || c.includes('bitcoin') || c.includes('ethereum') || c.includes('blockchain'))) return VIBES.crypto;
    if (apiCats.some(c => c.includes('politics') || c.includes('election'))) return VIBES.politics;
    if (apiCats.some(c => c.includes('sport') || c.includes('soccer') || c.includes('football') || c.includes('nba') || c.includes('premier league') || c.includes('off the pitch') || c.includes('recurring'))) return VIBES.sports;
    if (apiCats.some(c => c.includes('entertainment') || c.includes('movie') || c.includes('music') || c.includes('k-pop'))) return VIBES.entertainment;

    // 2. Fallback to keyword matching in title/slug
    if (text.includes("bitcoin") || text.includes("eth") || text.includes("crypto") || text.includes("solana") || text.includes("binance") || text.includes("token") || text.includes("price") || text.includes("above") || text.includes("below") || text.includes("$")) {
        return VIBES.crypto;
    }
    if (text.includes("election") || text.includes("trump") || text.includes("biden") || text.includes("harris") || text.includes("politics") || text.includes("government")) {
        return VIBES.politics;
    }
    if (text.includes("win") || text.includes("game") || text.includes("match") || text.includes("league") || text.includes("sports") || text.includes("football") || text.includes("soccer") || text.includes("nba") || text.includes("liverpool") || text.includes("salah") || text.includes("substitution") || text.includes("minute")) {
        return VIBES.sports;
    }
    if (text.includes("oscar") || text.includes("movie") || text.includes("entertainment") || text.includes("award") || text.includes("music")) {
        return VIBES.entertainment;
    }

    return VIBES.default;
}
