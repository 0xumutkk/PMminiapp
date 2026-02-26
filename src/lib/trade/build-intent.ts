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
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const encodeDynamicFunctionData = encodeFunctionData as unknown as (parameters: {
  abi: unknown;
  functionName: string;
  args: readonly unknown[];
}) => Hex;
const SUPPORTED_ROLES = new Set([
  "market",
  "side",
  "amount",
  "wallet",
  "recipient",
  "true",
  "false",
  "zero",
  "one"
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

function parseAmount(amountUsdc: string | undefined, decimals: number) {
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

  const minAmount = Number(process.env.TRADE_MIN_USDC ?? "1");
  const maxAmount = Number(process.env.TRADE_MAX_USDC ?? "1000");

  if (amount < minAmount || amount > maxAmount) {
    throw new Error(`amountUsdc must be between ${minAmount} and ${maxAmount}`);
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
    return process.env.LIMITLESS_TRADE_FUNCTION_SIGNATURE ?? "buyShares(bytes32,bool,uint256)";
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
    return process.env.LIMITLESS_TRADE_ARG_MAP ?? "market,side,amount";
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
  const amountUnits = needsAmount ? parseAmount(input.amountUsdc, usdcDecimals) : null;

  const tradeArgs = buildTradeArgs(parsedSignature, input, amountUnits, argMap);
  const tradeData = encodeDynamicFunctionData({
    abi: parseAbi([parsedSignature.normalizedSignature]),
    functionName: parsedSignature.functionName,
    args: tradeArgs
  });

  const calls: PreparedCall[] = [];
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
