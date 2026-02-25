export type TradeSide = "yes" | "no";

export type TradeIntentRequest = {
  marketId: string;
  side: TradeSide;
  amountUsdc: string;
  walletAddress: string;
  expectedPrice?: number;
  maxSlippageBps?: number;
};

export type BuildTradeIntentInput = TradeIntentRequest & {
  tradeContract: `0x${string}`;
  usdcToken?: `0x${string}`;
  functionSignature?: string;
  argMap?: string;
  executionPrice?: number;
};

export type PreparedCall = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
};

export type TradeIntentSuccess = {
  mode: "onchain";
  version: "v1";
  calls: PreparedCall[];
  meta: {
    marketId: string;
    side: TradeSide;
    amountUsdc: string;
    amountUnits: string;
    executionPrice?: number;
    expectedPrice?: number;
    slippageBps?: number;
    maxSlippageBps?: number;
  };
};

export type TradeIntentDisabled = {
  mode: "disabled";
  reason: string;
};

export type TradeIntentResponse = TradeIntentSuccess | TradeIntentDisabled;
