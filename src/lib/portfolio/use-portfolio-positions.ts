"use client";

import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import { useCallback } from "react";
import { useAccount } from "wagmi";

export const PORTFOLIO_POSITIONS_STALE_TIME_MS = 15_000;

export function getPortfolioPositionsQueryKey(account: string | null) {
  return ["portfolio-positions", account] as const;
}

export async function fetchPortfolioPositions(
  account: string,
  authHeaders: Record<string, string>,
  fresh = false
): Promise<PortfolioPositionsSnapshot> {
  const params = new URLSearchParams({ account });
  if (fresh) {
    params.set("fresh", "1");
  }

  const response = await fetch(`/api/portfolio/positions?${params.toString()}`, {
    cache: "no-store",
    credentials: "include",
    headers: authHeaders
  });
  const body = (await response.json().catch(() => null)) as PortfolioPositionsSnapshot | { error?: string } | null;

  if (!response.ok || !body || ("error" in body && body.error)) {
    const message =
      body && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to load positions (${response.status})`;
    throw new Error(message);
  }

  return body as PortfolioPositionsSnapshot;
}

export function usePortfolioPositions() {
  const { address } = useAccount();
  const { user, isAuthenticated, getAuthHeaders } = useMiniAppAuth();
  const queryClient = useQueryClient();
  // Portfolio positions belong to the connected wallet, not the auth identity.
  const account = address ?? user?.address ?? null;
  const enabled = Boolean(account && isAuthenticated && isAddress(account));
  const queryKey = getPortfolioPositionsQueryKey(account);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchPortfolioPositions(account as string, getAuthHeaders()),
    enabled,
    refetchInterval: enabled ? 20_000 : false,
    placeholderData: (previousData) => previousData,
    staleTime: PORTFOLIO_POSITIONS_STALE_TIME_MS,
    retry: 0
  });

  const refetch = useCallback(async () => {
    if (!enabled || !account) {
      return null;
    }

    try {
      const snapshot = await fetchPortfolioPositions(account, getAuthHeaders(), true);
      queryClient.setQueryData(queryKey, snapshot);
      return snapshot;
    } catch (error) {
      console.warn("[Portfolio Positions] Fresh refetch failed:", error);
      return (queryClient.getQueryData(queryKey) as PortfolioPositionsSnapshot | undefined) ?? null;
    }
  }, [account, enabled, getAuthHeaders, queryClient, queryKey]);

  return {
    account,
    isAuthenticated,
    snapshot: query.data ?? null,
    loading: query.isLoading || (query.isFetching && !query.data),
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch
  };
}
