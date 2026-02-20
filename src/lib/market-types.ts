export type MarketStatus = "open" | "closed" | "resolved";

export type MarketTradeVenue = {
  venueExchange?: `0x${string}`;
  venueAdapter?: `0x${string}`;
  functionSignature?: string;
  argMap?: string;
};

export type Market = {
  id: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume24h?: number;
  endsAt?: string;
  status: MarketStatus;
  tradeVenue?: MarketTradeVenue;
  source: "limitless";
};

export type MarketSnapshot = {
  updatedAt: string;
  markets: Market[];
};
