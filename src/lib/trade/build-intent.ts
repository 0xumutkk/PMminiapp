import { Address, Hex, encodeFunctionData, isAddress, keccak256, parseAbi, parseUnits, stringToBytes } from "viem";
import { BuildTradeIntentInput, PreparedCall, TradeIntentRequest, TradeIntentResponse } from "@/lib/trade/trade-types";

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

function parseAmount(amountUsdc: string, decimals: number) {
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

function convertArg(role: string, argType: string, request: TradeIntentRequest, amountUnits: bigint) {
  if (role === "side") {
    if (argType === "bool") {
      return request.side === "yes";
    }

    if (argType.startsWith("uint")) {
      return request.side === "yes" ? 1n : 0n;
    }

    return request.side;
  }

  if (role === "amount") {
    if (argType.startsWith("uint")) {
      return amountUnits;
    }

    return amountUnits.toString();
  }

  // role: market
  if (argType === "bytes32") {
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
  amountUnits: bigint,
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
    if (!["market", "side", "amount"].includes(role)) {
      throw new Error("LIMITLESS_TRADE_ARG_MAP supports only market,side,amount roles");
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

export function buildTradeIntent(input: BuildTradeIntentInput): TradeIntentResponse {
  const contracts = resolveTokens(input);

  const signature =
    input.functionSignature ??
    process.env.LIMITLESS_TRADE_FUNCTION_SIGNATURE ??
    "buyShares(bytes32,bool,uint256)";

  const argMap = input.argMap ?? process.env.LIMITLESS_TRADE_ARG_MAP ?? "market,side,amount";
  const parsedSignature = parseFunctionSignature(signature);
  const usdcDecimals = Number(process.env.USDC_DECIMALS ?? "6");
  const amountUnits = parseAmount(input.amountUsdc, usdcDecimals);

  const approveData = encodeFunctionData({
    abi: parseAbi([APPROVE_SIGNATURE]),
    functionName: "approve",
    args: [contracts.tradeContract, amountUnits]
  });

  const tradeArgs = buildTradeArgs(parsedSignature, input, amountUnits, argMap);
  const tradeData = encodeDynamicFunctionData({
    abi: parseAbi([parsedSignature.normalizedSignature]),
    functionName: parsedSignature.functionName,
    args: tradeArgs
  });

  const calls: PreparedCall[] = [
    {
      to: contracts.usdcToken,
      data: approveData,
      value: "0"
    },
    {
      to: contracts.tradeContract,
      data: tradeData,
      value: "0"
    }
  ];

  return {
    mode: "onchain",
    version: "v1",
    calls,
    meta: {
      marketId: input.marketId,
      side: input.side,
      amountUsdc: input.amountUsdc,
      amountUnits: amountUnits.toString(),
      executionPrice: input.executionPrice,
      expectedPrice: input.expectedPrice,
      maxSlippageBps: input.maxSlippageBps
    }
  };
}
