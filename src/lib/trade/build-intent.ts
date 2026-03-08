import {
  Address,
  Hex,
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  stringToBytes,
  stringToHex
} from "viem";
import { BuildTradeIntentInput, PreparedCall, TradeIntentAction, TradeIntentRequest, TradeIntentResponse } from "@/lib/trade/trade-types";

type ParsedFunctionSignature = {
  functionName: string;
  parameterTypes: string[];
  normalizedSignature: string;
};

const APPROVE_SIGNATURE = "function approve(address spender,uint256 value)";
const SET_APPROVAL_FOR_ALL_SIGNATURE = "function setApprovalForAll(address operator,bool approved)";
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const encodeDynamicFunctionData = encodeFunctionData as unknown as (parameters: {
  abi: unknown;
  functionName: string;
  args: readonly unknown[];
}) => Hex;
const SUPPORTED_ROLES = new Set([
  "market",
  "side",
  "outcome-index",
  "amount",
  "wallet",
  "recipient",
  "true",
  "false",
  "zero",
  "one",
  "min-tokens"
]);

function parseFunctionSignature(signature: string): ParsedFunctionSignature {
  const trimmed = signature.trim().replace(/^function\s+/, "");
  const match = /^(?<name>[a-zA-Z_][a-zA-Z0-9_]*)\((?<params>.*)\)$/.exec(trimmed);
  if (!match?.groups) {
    throw new Error("Invalid LIMITLESS_TRADE_FUNCTION_SIGNATURE format");
  }

  const functionName = match.groups.name;
  const parameterTypes = match.groups.params
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    functionName,
    parameterTypes,
    normalizedSignature: `function ${functionName}(${parameterTypes.join(",")})`
  };
}

function parseAmount(amountUsdc: string | undefined, decimals: number, action?: string) {
  if (!amountUsdc) {
    throw new Error("amountUsdc is required for this action");
  }

  if (!/^\d+(\.\d+)?$/.test(amountUsdc)) {
    throw new Error("amountUsdc must be a decimal string");
  }

  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amountUsdc must be greater than 0");
  }

  const maxAmount = Number(process.env.TRADE_MAX_USDC ?? "1000");
  if (amount > maxAmount) {
    throw new Error(`amountUsdc must not exceed ${maxAmount}`);
  }

  // Minimum only applies to buy — sell/redeem must allow any positive position size.
  if (!action || action === "buy") {
    const minAmount = Number(process.env.TRADE_MIN_USDC ?? "1");
    if (amount < minAmount) {
      throw new Error(`amountUsdc must be at least ${minAmount} for a buy`);
    }
  }

  return parseUnits(amountUsdc, decimals);
}

function marketIdToUint256(marketId: string) {
  if (/^\d+$/.test(marketId)) {
    return BigInt(marketId);
  }

  const digest = keccak256(stringToBytes(marketId));
  return BigInt(digest);
}

function parseBooleanLiteral(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`Invalid boolean literal: ${raw}`);
}

function parseConstArg(rawLiteral: string, argType: string) {
  const literal = rawLiteral.trim();

  if (argType === "bool") {
    return parseBooleanLiteral(literal);
  }

  if (argType.startsWith("uint") || argType.startsWith("int")) {
    return BigInt(literal);
  }

  if (argType === "address") {
    if (!isAddress(literal)) {
      throw new Error(`Invalid address literal: ${literal}`);
    }
    return literal as Address;
  }

  if (argType === "string") {
    return literal;
  }

  if (argType === "bytes32") {
    if (/^0x[0-9a-fA-F]{64}$/.test(literal)) {
      return literal as Hex;
    }

    return keccak256(stringToBytes(literal));
  }

  if (argType.startsWith("bytes")) {
    if (/^0x[0-9a-fA-F]*$/.test(literal)) {
      return literal as Hex;
    }

    return stringToHex(literal);
  }

  throw new Error(`Unsupported const argument type: ${argType}`);
}

function convertArg(role: string, argType: string, request: TradeIntentRequest, amountUnits: bigint | null) {
  if (role.startsWith("const:")) {
    return parseConstArg(role.slice("const:".length), argType);
  }

  if (role === "side") {
    if (!request.side) {
      throw new Error("side is required for this action");
    }

    if (argType === "bool") {
      return request.side === "yes";
    }

    if (argType.startsWith("uint")) {
      return request.side === "yes" ? 1n : 0n;
    }

    return request.side;
  }

  // AMM FPMM outcomeIndex: 0 = YES, 1 = NO (opposite of the `side` uint role above)
  if (role === "outcome-index") {
    if (!request.side) {
      throw new Error("side is required for outcome-index role");
    }
    if (argType.startsWith("uint")) {
      return request.side === "yes" ? 0n : 1n;
    }
    throw new Error(`outcome-index role only supports uint types, got: ${argType}`);
  }

  if (role === "amount") {
    if (amountUnits === null) {
      throw new Error("amountUsdc is required by LIMITLESS_*_ARG_MAP");
    }

    if (argType.startsWith("uint")) {
      return amountUnits;
    }

    return amountUnits.toString();
  }

  if (role === "wallet" || role === "recipient") {
    if (!isAddress(request.walletAddress)) {
      throw new Error("walletAddress must be a valid address");
    }

    if (argType === "address") {
      return request.walletAddress as Address;
    }

    if (argType === "string") {
      return request.walletAddress;
    }

    throw new Error(`Unsupported ${role} argument type: ${argType}`);
  }

  if (role === "true" || role === "false") {
    const value = role === "true";
    if (argType === "bool") {
      return value;
    }
    if (argType.startsWith("uint") || argType.startsWith("int")) {
      return value ? 1n : 0n;
    }
    throw new Error(`Unsupported boolean flag argument type: ${argType}`);
  }

  if (role === "zero" || role === "one") {
    const value = role === "one" ? 1n : 0n;
    if (argType.startsWith("uint") || argType.startsWith("int")) {
      return value;
    }
    if (argType === "bool") {
      return value === 1n;
    }
    throw new Error(`Unsupported numeric flag argument type: ${argType}`);
  }

  // min-tokens: calculates minimum acceptable outcome tokens for on-chain slippage protection
  // Formula: investmentAmount / expectedPrice * (1 - slippageTolerance)
  if (role === "min-tokens") {
    if (!argType.startsWith("uint")) {
      throw new Error(`min-tokens role only supports uint types, got: ${argType}`);
    }

    const expectedPrice = request.expectedPrice;
    const slippageBps = request.maxSlippageBps ?? 200; // default 2%

    // If no expected price, fall back to 0 (no on-chain guard — backend still checks)
    if (!expectedPrice || expectedPrice <= 0 || expectedPrice >= 1 || !amountUnits) {
      return 0n;
    }

    // expectedShares = investmentAmount / expectedPrice
    // minShares = expectedShares * (1 - slippage)
    // All in 1e6 scale (USDC decimals)
    const slippageMultiplier = 1 - (slippageBps / 10000);
    const expectedShares = Number(amountUnits) / expectedPrice;
    const minShares = Math.floor(expectedShares * slippageMultiplier);

    return minShares > 0 ? BigInt(minShares) : 0n;
  }

  if (role !== "market") {
    throw new Error(`Unsupported arg role: ${role}`);
  }

  if (argType === "bytes32") {
    if (/^0x[0-9a-fA-F]{64}$/.test(request.marketId)) {
      return request.marketId as Hex;
    }
    return keccak256(stringToBytes(request.marketId));
  }

  if (argType.startsWith("uint")) {
    return marketIdToUint256(request.marketId);
  }

  if (argType === "string") {
    return request.marketId;
  }

  if (argType.startsWith("bytes")) {
    return `0x${Buffer.from(request.marketId, "utf8").toString("hex")}` as Hex;
  }

  throw new Error(`Unsupported market argument type: ${argType}`);
}

function buildTradeArgs(
  parsedSignature: ParsedFunctionSignature,
  request: TradeIntentRequest,
  amountUnits: bigint | null,
  argMapRaw: string
) {
  const argMap = argMapRaw
    .split(",")
    .map((item) => item.trim());

  if (argMap.length !== parsedSignature.parameterTypes.length) {
    throw new Error(
      `LIMITLESS_TRADE_ARG_MAP length (${argMap.length}) must match function argument count (${parsedSignature.parameterTypes.length})`
    );
  }

  return parsedSignature.parameterTypes.map((argType, index) => {
    const role = argMap[index];
    if (!SUPPORTED_ROLES.has(role) && !role.startsWith("const:")) {
      throw new Error(
        "LIMITLESS_*_ARG_MAP supports market,side,amount,wallet,recipient,true,false,zero,one,const:* roles"
      );
    }

    return convertArg(role, argType, request, amountUnits);
  });
}

function resolveTokens(input: BuildTradeIntentInput) {
  const usdcTokenCandidate =
    input.usdcToken ?? process.env.USDC_TOKEN_ADDRESS ?? process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS ?? BASE_USDC_ADDRESS;

  if (!isAddress(usdcTokenCandidate)) {
    throw new Error("USDC token address is invalid");
  }

  if (!isAddress(input.tradeContract)) {
    throw new Error("Market venue exchange address is invalid");
  }

  return {
    usdcToken: usdcTokenCandidate as Address,
    tradeContract: input.tradeContract as Address
  };
}

function resolveActionSignature(action: TradeIntentAction, explicitSignature?: string) {
  if (explicitSignature) {
    return explicitSignature;
  }

  if (action === "buy") {
    // Limitless AMM contract: buy(uint256 investmentAmount, uint256 outcomeIndex, uint256 minOutcomeTokensToBuy)
    // outcomeIndex: 0 = YES, 1 = NO  |  minOutcomeTokensToBuy: 0 = no slippage guard (market order)
    return process.env.LIMITLESS_TRADE_FUNCTION_SIGNATURE ?? "buy(uint256,uint256,uint256)";
  }

  if (action === "sell") {
    return process.env.LIMITLESS_SELL_FUNCTION_SIGNATURE ?? "sellShares(bytes32,bool,uint256)";
  }

  return process.env.LIMITLESS_REDEEM_FUNCTION_SIGNATURE ?? "redeemShares(bytes32,bool)";
}

function resolveActionArgMap(action: TradeIntentAction, explicitArgMap?: string) {
  if (explicitArgMap) {
    return explicitArgMap;
  }

  if (action === "buy") {
    // Limitless AMM contract: buy(uint256 investmentAmount, uint256 outcomeIndex, uint256 minOutcomeTokensToBuy)
    // outcomeIndex: 0 = YES, 1 = NO  |  min-tokens = on-chain slippage guard
    return process.env.LIMITLESS_TRADE_ARG_MAP ?? "amount,outcome-index,min-tokens";
  }

  if (action === "sell") {
    return process.env.LIMITLESS_SELL_ARG_MAP ?? "market,side,amount";
  }

  return process.env.LIMITLESS_REDEEM_ARG_MAP ?? "market,side";
}

function shouldIncludeUsdcApprove(action: TradeIntentAction, explicitFlag?: boolean) {
  if (typeof explicitFlag === "boolean") {
    return explicitFlag;
  }

  const configured = process.env.TRADE_APPROVE_ACTIONS;
  if (configured) {
    const allowed = configured
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    if (allowed.length > 0) {
      return allowed.includes(action);
    }
  }

  return action === "buy";
}

export function buildTradeIntent(input: BuildTradeIntentInput): TradeIntentResponse {
  const contracts = resolveTokens(input);

  // ──── REDEEM: CT.redeemPositions(collateral, parentCollectionId, conditionId, indexSets) ────
  if (input.action === "redeem" && input.conditionId) {
    const REDEEM_ABI = parseAbi([
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
    ]);

    const redeemData = encodeFunctionData({
      abi: REDEEM_ABI,
      functionName: "redeemPositions",
      args: [
        contracts.usdcToken,       // collateral = USDC
        "0x0000000000000000000000000000000000000000000000000000000000000000", // parentCollectionId
        input.conditionId,         // conditionId from FPMM
        [1n, 2n]                   // indexSets: YES=1, NO=2
      ]
    });

    return {
      mode: "onchain",
      version: "v1",
      calls: [
        {
          to: contracts.tradeContract, // = CT address
          data: redeemData,
          value: "0"
        }
      ],
      meta: {
        action: "redeem",
        marketId: input.marketId,
        side: input.side,
        amountUsdc: input.amountUsdc,
        amountUnits: undefined,
        executionPrice: undefined,
        expectedPrice: undefined,
        maxSlippageBps: undefined
      }
    };
  }

  // ──── BUY / SELL ────
  const signature = resolveActionSignature(input.action, input.functionSignature);
  if (!signature) {
    throw new Error(`Function signature is missing for ${input.action} action`);
  }

  const argMap = resolveActionArgMap(input.action, input.argMap);
  if (!argMap) {
    throw new Error(`Argument map is missing for ${input.action} action`);
  }

  const parsedSignature = parseFunctionSignature(signature);
  const argRoles = argMap
    .split(",")
    .map((item) => item.trim());
  const needsAmount = argRoles.includes("amount");
  const usdcDecimals = Number(process.env.USDC_DECIMALS ?? "6");
  const amountUnits = needsAmount ? parseAmount(input.amountUsdc, usdcDecimals, input.action) : null;

  const tradeArgs = buildTradeArgs(parsedSignature, input, amountUnits, argMap);
  const tradeData = encodeDynamicFunctionData({
    abi: parseAbi([parsedSignature.normalizedSignature]),
    functionName: parsedSignature.functionName,
    args: tradeArgs
  });

  const calls: PreparedCall[] = [];

  // BUY: prepend USDC ERC-20 approve
  if (shouldIncludeUsdcApprove(input.action, input.requireUsdcApprove)) {
    if (amountUnits === null) {
      throw new Error("USDC approve requires amountUsdc via amount role");
    }

    const approveData = encodeFunctionData({
      abi: parseAbi([APPROVE_SIGNATURE]),
      functionName: "approve",
      args: [contracts.tradeContract, amountUnits]
    });

    calls.push({
      to: contracts.usdcToken,
      data: approveData,
      value: "0"
    });
  }

  // SELL (AMM): prepend ERC-1155 setApprovalForAll on ConditionalTokens
  if (input.conditionalTokensContract && isAddress(input.conditionalTokensContract)) {
    const setApprovalData = encodeFunctionData({
      abi: parseAbi([SET_APPROVAL_FOR_ALL_SIGNATURE]),
      functionName: "setApprovalForAll",
      args: [contracts.tradeContract, true]
    });

    calls.push({
      to: input.conditionalTokensContract,
      data: setApprovalData,
      value: "0"
    });
  }

  calls.push({
    to: contracts.tradeContract,
    data: tradeData,
    value: "0"
  });

  return {
    mode: "onchain",
    version: "v1",
    calls,
    meta: {
      action: input.action,
      marketId: input.marketId,
      side: input.side,
      amountUsdc: input.amountUsdc,
      amountUnits: amountUnits?.toString(),
      executionPrice: input.executionPrice,
      expectedPrice: input.expectedPrice,
      maxSlippageBps: input.maxSlippageBps
    }
  };
}
