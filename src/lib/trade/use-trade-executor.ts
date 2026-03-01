"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSendCalls,
  useSendTransaction,
  useWaitForCallsStatus
} from "wagmi";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import { TradeIntentAction, TradeIntentResponse, TradeIntentSuccess, TradeSide } from "@/lib/trade/trade-types";

type TradeExecutionStatus =
  | "idle"
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed";

type TradeState = {
  status: TradeExecutionStatus;
  error: string | null;
  currentAction: TradeIntentAction | null;
  batchId: string | null;
  txHashes: `0x${string}`[];
  totalCalls: number;
  submittedCalls: number;
  pendingTrade: ConfirmedTrade | null;
  lastConfirmedTrade: ConfirmedTrade | null;
};

type ExecuteTradeParams = {
  marketId: string;
  side: TradeSide;
  amountUsdc: string;
  expectedPrice?: number;
  maxSlippageBps?: number;
};

type ExecuteIntentParams = {
  action: TradeIntentAction;
  marketId: string;
  side?: TradeSide;
  amountUsdc?: string;
  expectedPrice?: number;
  maxSlippageBps?: number;
};

type ConfirmedTrade = {
  action: TradeIntentAction;
  marketId: string;
  side?: TradeSide;
  amountUsdc?: string;
  executionPrice?: number;
  confirmedAt: string;
};

function errorToMessage(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.shortMessage === "string") {
      return record.shortMessage;
    }

    if (typeof record.message === "string") {
      return record.message;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown trade error";
}

function notifyPositionsRefresh() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent("positions:refresh"));
}

function actionLabel(action: TradeIntentAction) {
  if (action === "sell") {
    return "sell";
  }
  if (action === "redeem") {
    return "redeem";
  }
  return "trade";
}

export function useTradeExecutor() {
  const { address, isConnected } = useAccount();
  const { user, getAuthHeaders } = useMiniAppAuth();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId });

  const tradeAddress = user?.address ?? address;

  const { sendCallsAsync, isPending: isBatchSending } = useSendCalls();
  const { sendTransactionAsync, isPending: isTxSending } = useSendTransaction();

  const [state, setState] = useState<TradeState>({
    status: "idle",
    error: null,
    currentAction: null,
    batchId: null,
    txHashes: [],
    totalCalls: 0,
    submittedCalls: 0,
    pendingTrade: null,
    lastConfirmedTrade: null
  });

  const callsStatus = useWaitForCallsStatus({
    id: state.batchId ?? undefined,
    pollingInterval: 1000,
    retryCount: 90,
    timeout: 180_000,
    query: {
      enabled: Boolean(state.batchId)
    }
  });

  useEffect(() => {
    const status = callsStatus.data?.status;
    if (!status) {
      return;
    }

    if (status === "pending") {
      setState((current) =>
        current.status === "submitted" ? current : { ...current, status: "submitted", error: null }
      );
      return;
    }

    if (status === "success") {
      const txHashes =
        callsStatus.data?.receipts
          ?.map((receipt) => receipt.transactionHash as `0x${string}`)
          .filter((hash) => typeof hash === "string" && hash.startsWith("0x")) ?? [];

      setState((current) => ({
        ...current,
        status: "confirmed",
        error: null,
        totalCalls: 0,
        submittedCalls: 0,
        txHashes: txHashes.length > 0 ? txHashes : current.txHashes,
        currentAction: current.pendingTrade?.action ?? current.currentAction,
        lastConfirmedTrade: current.pendingTrade
          ? {
            ...current.pendingTrade,
            confirmedAt: new Date().toISOString()
          }
          : current.lastConfirmedTrade,
        pendingTrade: null
      }));
      notifyPositionsRefresh();
      return;
    }

    if (status === "failure") {
      setState((current) => ({
        ...current,
        status: "failed",
        error: "Batch transaction failed",
        currentAction: current.currentAction,
        totalCalls: 0,
        submittedCalls: 0,
        pendingTrade: null
      }));
    }
  }, [callsStatus.data]);

  const executeIntent = useCallback(
    async (params: ExecuteIntentParams) => {
      if (!isConnected || !address) {
        throw new Error("Wallet must be connected before trading");
      }

      if (user && address.toLowerCase() !== user.address.toLowerCase()) {
        throw new Error(
          "Wallet mismatch. Please connect with your authenticated wallet to trade."
        );
      }

      const walletForTrade = tradeAddress ?? address;
      if (!walletForTrade) {
        throw new Error("Wallet must be connected before trading");
      }

      setState((current) => ({
        ...current,
        status: "preparing",
        error: null,
        currentAction: params.action,
        batchId: null,
        txHashes: [],
        totalCalls: 0,
        submittedCalls: 0,
        pendingTrade: null
      }));

      try {
        const response = await fetch("/api/trade/intent", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders()
          },
          body: JSON.stringify({
            action: params.action,
            marketId: params.marketId,
            side: params.side,
            amountUsdc: params.amountUsdc,
            walletAddress: walletForTrade,
            expectedPrice: params.expectedPrice,
            maxSlippageBps: params.maxSlippageBps
          })
        });

        const body = (await response.json()) as
          | TradeIntentResponse
          | {
            error?: string;
            guard?: {
              expectedPrice?: number;
              executionPrice?: number;
              slippageBps?: number;
              maxSlippageBps?: number;
            };
          };

        if (!response.ok) {
          const guardMessage =
            "guard" in body && body.guard
              ? ` Expected ${Number(body.guard.expectedPrice ?? 0).toFixed(3)}, current ${Number(
                body.guard.executionPrice ?? 0
              ).toFixed(3)}, slippage ${body.guard.slippageBps ?? "-"}bps (max ${body.guard.maxSlippageBps ?? "-"}bps).`
              : "";
          throw new Error(
            (("error" in body && body.error) || `Trade intent failed with ${response.status}`) + guardMessage
          );
        }

        if (!("mode" in body) || body.mode !== "onchain") {
          const reason = "mode" in body ? body.reason : "Trade mode is disabled";
          throw new Error(reason);
        }

        const calls = body.calls.map((call) => ({
          to: call.to,
          data: call.data,
          value: call.value ? BigInt(call.value) : 0n
        }));
        const totalCalls = calls.length;
        const intentMeta = (body as TradeIntentSuccess).meta;
        const pendingTrade: ConfirmedTrade = {
          action: params.action,
          marketId: params.marketId,
          side: params.side,
          amountUsdc: params.amountUsdc,
          executionPrice: intentMeta.executionPrice,
          confirmedAt: new Date().toISOString()
        };

        setState((current) => ({ ...current, status: "awaiting_signature", error: null }));

        try {
          const batch = await sendCallsAsync({
            account: address,
            chainId,
            calls,
            forceAtomic: true
          });

          setState((current) => ({
            ...current,
            status: "submitted",
            error: null,
            batchId: batch.id,
            totalCalls,
            submittedCalls: 0,
            txHashes: [],
            pendingTrade
          }));
          return;
        } catch {
          // Fallback for wallets without EIP-5792 support: send sequential transactions.
          const txHashes: `0x${string}`[] = [];

          for (const call of calls) {
            setState((current) => ({
              ...current,
              status: "awaiting_signature",
              error: null,
              batchId: null,
              totalCalls,
              submittedCalls: txHashes.length,
              pendingTrade
            }));

            const hash = await sendTransactionAsync({
              account: address,
              chainId,
              to: call.to,
              data: call.data,
              value: call.value
            });

            txHashes.push(hash);
            setState((current) => ({
              ...current,
              status: "submitted",
              batchId: null,
              totalCalls,
              submittedCalls: txHashes.length,
              txHashes: [...txHashes]
            }));

            // Crucial for non-batched wallets: We must wait for this transaction to be mined
            // before asking the wallet to sign the next one. Otherwise, the wallet's local
            // simulation (eth_estimateGas) for the next transaction (e.g. Trade) will fail
            // because the state change (e.g. USDC Approve) hasn't been confirmed on-chain yet.
            if (publicClient) {
              const receipt = await publicClient.waitForTransactionReceipt({
                hash,
                confirmations: 1,
                timeout: 120_000
              });
              if (receipt.status !== "success") {
                throw new Error(`Transaction reverted: ${hash}`);
              }
            }
          }

          setState((current) => ({
            ...current,
            status: "confirmed",
            error: null,
            batchId: null,
            totalCalls: 0,
            submittedCalls: 0,
            txHashes,
            pendingTrade: null,
            lastConfirmedTrade: {
              ...pendingTrade,
              confirmedAt: new Date().toISOString()
            }
          }));
          notifyPositionsRefresh();
        }
      } catch (error) {
        setState((current) => ({
          ...current,
          status: "failed",
          error: errorToMessage(error),
          batchId: null,
          totalCalls: 0,
          submittedCalls: 0,
          pendingTrade: null
        }));
      }
    },
    [address, chainId, isConnected, publicClient, sendCallsAsync, sendTransactionAsync, tradeAddress, user, getAuthHeaders]
  );

  const executeTrade = useCallback(
    async (params: ExecuteTradeParams) => {
      return executeIntent({
        action: "buy",
        ...params
      });
    },
    [executeIntent]
  );

  const resetTradeState = useCallback(() => {
    setState((current) => ({
      ...current,
      status: "idle",
      error: null,
      currentAction: null,
      batchId: null,
      totalCalls: 0,
      submittedCalls: 0,
      pendingTrade: null
    }));
  }, []);

  const isBusy =
    state.status === "preparing" ||
    state.status === "awaiting_signature" ||
    state.status === "submitted" ||
    isBatchSending ||
    isTxSending;

  const statusLabel = useMemo(() => {
    if (state.status === "idle") {
      return "Ready";
    }

    if (state.status === "preparing") {
      return `Preparing ${actionLabel(state.currentAction ?? "buy")}...`;
    }

    if (state.status === "awaiting_signature") {
      if (state.totalCalls > 1) {
        return `Sign transaction ${state.submittedCalls + 1}/${state.totalCalls} in your wallet...`;
      }
      return `Waiting for ${actionLabel(state.currentAction ?? "buy")} signature...`;
    }

    if (state.status === "submitted") {
      if (state.totalCalls > 1) {
        return `Transaction ${state.submittedCalls}/${state.totalCalls} submitted`;
      }
      return state.batchId
        ? `${actionLabel(state.currentAction ?? "buy")} batch submitted on Base`
        : `${actionLabel(state.currentAction ?? "buy")} transaction submitted`;
    }

    if (state.status === "confirmed") {
      const action = state.lastConfirmedTrade?.action ?? state.pendingTrade?.action ?? "buy";
      if (action === "sell") {
        return "Sell confirmed";
      }
      if (action === "redeem") {
        return "Redeem confirmed";
      }
      return "Trade confirmed";
    }

    return state.error ?? "Trade failed";
  }, [
    state.batchId,
    state.currentAction,
    state.error,
    state.lastConfirmedTrade?.action,
    state.pendingTrade?.action,
    state.status,
    state.submittedCalls,
    state.totalCalls
  ]);

  return {
    executeIntent,
    executeTrade,
    resetTradeState,
    state,
    lastConfirmedTrade: state.lastConfirmedTrade,
    isBusy,
    isConnected,
    statusLabel,
    isBatchWaiting: callsStatus.isFetching
  };
}
