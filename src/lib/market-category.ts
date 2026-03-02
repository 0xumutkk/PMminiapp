import type { Market } from "@/lib/market-types";

export type MarketCategoryId =
  | "crypto"
  | "politics"
  | "science"
  | "sports"
  | "conspiracy"
  | "economy"
  | "other";

export type MarketCategoryFilter = "all" | MarketCategoryId;

type CategoryDefinition = {
  id: MarketCategoryId;
  label: string;
  pattern: RegExp;
};

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    id: "crypto",
    label: "Crypto",
    pattern: /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|token|defi|airdrop|stablecoin)\b/i
  },
  {
    id: "politics",
    label: "Politics",
    pattern: /\b(election|president|senate|congress|policy|government|minister|parliament|campaign|white house)\b/i
  },
  {
    id: "science",
    label: "Science",
    pattern: /\b(science|nasa|space|ai|artificial intelligence|quantum|ufo|alien|biology|physics)\b/i
  },
  {
    id: "sports",
    label: "Sports",
    pattern: /\b(nfl|nba|mlb|nhl|fifa|soccer|football|tennis|formula ?1|ufc|olympics|championship)\b/i
  },
  {
    id: "conspiracy",
    label: "Conspiracy",
    pattern: /\b(conspiracy|epstein|secret|cover[- ]?up|mystery|classified|whistleblower)\b/i
  },
  {
    id: "economy",
    label: "Economy",
    pattern: /\b(inflation|fed|interest rate|recession|gdp|oil|employment|cpi|bond|yield)\b/i
  }
];

const CATEGORY_LABELS: Record<MarketCategoryId, string> = {
  crypto: "Crypto",
  politics: "Politics",
  science: "Science",
  sports: "Sports",
  conspiracy: "Conspiracy",
  economy: "Economy",
  other: "Other"
};

const FILTER_VALUES = new Set<MarketCategoryFilter>([
  "all",
  "crypto",
  "politics",
  "science",
  "sports",
  "conspiracy",
  "economy",
  "other"
]);

export const CATEGORY_FILTER_OPTIONS: { id: MarketCategoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "crypto", label: "Crypto" },
  { id: "politics", label: "Politics" },
  { id: "science", label: "Science" },
  { id: "sports", label: "Sports" },
  { id: "conspiracy", label: "Conspiracy" },
  { id: "economy", label: "Economy" },
  { id: "other", label: "Other" }
];

export function inferMarketCategoryId(title: string, categories?: string[]): MarketCategoryId {
  // 1. Try mapping from API categories if they exist
  if (categories && categories.length > 0) {
    const apiCats = categories.map(c => c.toLowerCase());

    if (apiCats.some(c => c.includes('crypto') || c.includes('bitcoin') || c.includes('ethereum'))) return 'crypto';
    if (apiCats.some(c => c.includes('politics') || c.includes('election'))) return 'politics';
    if (apiCats.some(c => c.includes('science') || c.includes('space') || c.includes('ai'))) return 'science';
    if (apiCats.some(c => c.includes('sport') || c.includes('soccer') || c.includes('football') || c.includes('nba'))) return 'sports';
    if (apiCats.some(c => c.includes('economy') || c.includes('fed') || c.includes('inflation'))) return 'economy';
    if (apiCats.some(c => c.includes('conspiracy'))) return 'conspiracy';
  }

  // 2. Fallback to title-based regex matching
  for (const definition of CATEGORY_DEFINITIONS) {
    if (definition.pattern.test(title)) {
      return definition.id;
    }
  }

  return "other";
}

export function marketCategoryLabel(categoryId: MarketCategoryId): string {
  return CATEGORY_LABELS[categoryId];
}

export function parseMarketCategoryFilter(value: string | null): MarketCategoryFilter | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase() as MarketCategoryFilter;
  return FILTER_VALUES.has(normalized) ? normalized : null;
}

export function filterMarketsByCategory(markets: Market[], category: MarketCategoryFilter): Market[] {
  if (category === "all") {
    return markets;
  }

  return markets.filter((market) => inferMarketCategoryId(market.title) === category);
}
