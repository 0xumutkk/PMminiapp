export type MarketStatus = "open" | "closed" | "resolved";

export type MarketTradeVenue = {
  venueExchange?: `0x${string}`;
  venueAdapter?: `0x${string}`;
  marketRef?: string;
  functionSignature?: string;
  argMap?: string;
};

export type Market = {
  id: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  /** Minimum order size in shares (raw, not scaled). Multiply by yesPrice or noPrice to get USDC cost. */
  minTradeShares?: number;
  volume24h?: number;
  endsAt?: string;
  status: MarketStatus;
  tradeVenue?: MarketTradeVenue;
  /** ERC-1155 position token IDs: [YES tokenId, NO tokenId] as decimal strings */
  positionIds?: [string, string];
  source: "limitless";
  imageUrl?: string;
  categories?: string[];
  tags?: string[];
};

export type MarketSnapshot = {
  updatedAt: string;
  markets: Market[];
};
