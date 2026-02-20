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
import { TradeIntentResponse, TradeSide } from "@/lib/trade/trade-types";

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
  batchId: string | null;
  txHashes: `0x${string}`[];
};

type ExecuteTradeParams = {
  marketId: string;
  side: TradeSide;
  amountUsdc: string;
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

export function useTradeExecutor() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId });

  const { sendCallsAsync, isPending: isBatchSending } = useSendCalls();
  const { sendTransactionAsync, isPending: isTxSending } = useSendTransaction();

  const [state, setState] = useState<TradeState>({
    status: "idle",
    error: null,
    batchId: null,
    txHashes: []
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
      setState((current) => ({ ...current, status: "confirmed", error: null }));
      return;
    }

    if (status === "failure") {
      setState((current) => ({ ...current, status: "failed", error: "Batch transaction failed" }));
    }
  }, [callsStatus.data?.status]);

  const executeTrade = useCallback(
    async (params: ExecuteTradeParams) => {
      if (!isConnected || !address) {
        throw new Error("Wallet must be connected before trading");
      }

      setState({ status: "preparing", error: null, batchId: null, txHashes: [] });

      try {
        const response = await fetch("/api/trade/intent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            marketId: params.marketId,
            side: params.side,
            amountUsdc: params.amountUsdc,
            walletAddress: address
          })
        });

        const body = (await response.json()) as TradeIntentResponse | { error?: string };

        if (!response.ok) {
          throw new Error(("error" in body && body.error) || `Trade intent failed with ${response.status}`);
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
            txHashes: []
          }));
          return;
        } catch {
          // Fallback for wallets without EIP-5792 support: send sequential transactions.
          const txHashes: `0x${string}`[] = [];

          for (const call of calls) {
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
              txHashes: [...txHashes]
            }));

            if (publicClient) {
              await publicClient.waitForTransactionReceipt({ hash });
            }
          }

          setState((current) => ({
            ...current,
            status: "confirmed",
            error: null,
            batchId: null,
            txHashes
          }));
        }
      } catch (error) {
        setState({
          status: "failed",
          error: errorToMessage(error),
          batchId: null,
          txHashes: []
        });
      }
    },
    [address, chainId, isConnected, publicClient, sendCallsAsync, sendTransactionAsync]
  );

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
      return "Preparing trade...";
    }

    if (state.status === "awaiting_signature") {
      return "Waiting for signature...";
    }

    if (state.status === "submitted") {
      return state.batchId ? "Batch submitted on Base" : "Transaction submitted";
    }

    if (state.status === "confirmed") {
      return "Trade confirmed";
    }

    return state.error ?? "Trade failed";
  }, [state.batchId, state.error, state.status]);

  return {
    executeTrade,
    state,
    isBusy,
    isConnected,
    statusLabel,
    isBatchWaiting: callsStatus.isFetching
  };
}
