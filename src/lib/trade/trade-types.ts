export type TradeSide = "yes" | "no";
export type TradeIntentAction = "buy" | "sell" | "redeem";

export type TradeIntentRequest = {
  action?: TradeIntentAction;
  marketId: string;
  side?: TradeSide;
  amountUsdc?: string;
  walletAddress: string;
  expectedPrice?: number;
  maxSlippageBps?: number;
};

export type BuildTradeIntentInput = TradeIntentRequest & {
  action: TradeIntentAction;
  tradeContract: `0x${string}`;
  usdcToken?: `0x${string}`;
  functionSignature?: string;
  argMap?: string;
  executionPrice?: number;
  requireUsdcApprove?: boolean;
  /** For AMM sell: ConditionalTokens contract to approve ERC-1155 tokens to the FPMM. */
  conditionalTokensContract?: `0x${string}`;
  /** For redeem: the conditionId from the FPMM's conditionIds(0). */
  conditionId?: `0x${string}`;
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
    action: TradeIntentAction;
    marketId: string;
    side?: TradeSide;
    amountUsdc?: string;
    amountUnits?: string;
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
