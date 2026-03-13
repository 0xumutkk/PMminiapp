"use client";

import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import {
  createOptimisticPortfolioSnapshot,
  mergeOptimisticPortfolioBuys,
  OPTIMISTIC_PORTFOLIO_EVENT,
  readStoredOptimisticPortfolioBuys,
  type StoredOptimisticPortfolioBuy
} from "@/lib/portfolio/optimistic-portfolio";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress } from "viem";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";

export const PORTFOLIO_POSITIONS_STALE_TIME_MS = 15_000;
const BACKGROUND_FULL_SYNC_INTERVAL_MS = 60_000;
const BACKGROUND_CRITICAL_SYNC_INTERVAL_MS = 20_000;

export function getPortfolioPositionsQueryKey(account: string | null) {
  return ["portfolio-positions", account] as const;
}

export async function fetchPortfolioPositions(
  account: string,
  authHeaders: Record<string, string>,
  options: {
    fresh?: boolean;
    critical?: boolean;
  } = {}
): Promise<PortfolioPositionsSnapshot> {
  const params = new URLSearchParams({ account });
  if (options.fresh) {
    params.set("fresh", "1");
  }
  if (options.critical) {
    params.set("critical", "1");
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
  const backgroundFullSyncRef = useRef<Map<string, number>>(new Map());
  const backgroundCriticalSyncRef = useRef<Map<string, number>>(new Map());
  const [optimisticBuys, setOptimisticBuys] = useState<StoredOptimisticPortfolioBuy[]>([]);
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

  const refetchFull = useCallback(async () => {
    if (!enabled || !account) {
      return null;
    }

    try {
      const snapshot = await fetchPortfolioPositions(account, getAuthHeaders(), { fresh: true });
      queryClient.setQueryData(queryKey, snapshot);
      return snapshot;
    } catch (error) {
      console.warn("[Portfolio Positions] Fresh refetch failed:", error);
      return (queryClient.getQueryData(queryKey) as PortfolioPositionsSnapshot | undefined) ?? null;
    }
  }, [account, enabled, getAuthHeaders, queryClient, queryKey]);

  const refetchCritical = useCallback(async () => {
    if (!enabled || !account) {
      return null;
    }

    try {
      const snapshot = await fetchPortfolioPositions(account, getAuthHeaders(), {
        fresh: true,
        critical: true
      });
      queryClient.setQueryData(queryKey, snapshot);
      return snapshot;
    } catch (error) {
      console.warn("[Portfolio Positions] Critical refetch failed:", error);
      return (queryClient.getQueryData(queryKey) as PortfolioPositionsSnapshot | undefined) ?? null;
    }
  }, [account, enabled, getAuthHeaders, queryClient, queryKey]);

  const refetch = useCallback(async () => {
    const criticalSnapshot = await refetchCritical();
    void refetchFull();
    return criticalSnapshot;
  }, [refetchCritical, refetchFull]);

  useEffect(() => {
    if (!enabled || !account) {
      return;
    }

    if (!query.data) {
      return;
    }

    const normalizedAccount = account.toLowerCase();
    const lastCriticalSyncAt = backgroundCriticalSyncRef.current.get(normalizedAccount) ?? 0;
    if (Date.now() - lastCriticalSyncAt < BACKGROUND_CRITICAL_SYNC_INTERVAL_MS) {
      return;
    }

    backgroundCriticalSyncRef.current.set(normalizedAccount, Date.now());
    void refetchCritical();
  }, [account, enabled, query.data, query.dataUpdatedAt, refetchCritical]);

  useEffect(() => {
    if (!enabled || !account || !query.data) {
      return;
    }

    const normalizedAccount = account.toLowerCase();
    const now = Date.now();
    const lastFullSyncAt = backgroundFullSyncRef.current.get(normalizedAccount);

    if (!lastFullSyncAt) {
      backgroundFullSyncRef.current.set(normalizedAccount, now);
      return;
    }

    if (now - lastFullSyncAt < BACKGROUND_FULL_SYNC_INTERVAL_MS) {
      return;
    }

    backgroundFullSyncRef.current.set(normalizedAccount, now);
    void refetchFull();
  }, [account, enabled, query.data, query.dataUpdatedAt, refetchFull]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncOptimisticBuys = () => {
      setOptimisticBuys(readStoredOptimisticPortfolioBuys(account));
    };

    syncOptimisticBuys();
    window.addEventListener(OPTIMISTIC_PORTFOLIO_EVENT, syncOptimisticBuys);
    window.addEventListener("storage", syncOptimisticBuys);

    return () => {
      window.removeEventListener(OPTIMISTIC_PORTFOLIO_EVENT, syncOptimisticBuys);
      window.removeEventListener("storage", syncOptimisticBuys);
    };
  }, [account]);

  const mergedSnapshot = useMemo(() => {
    if (!enabled || !account) {
      return query.data ?? null;
    }

    const baseSnapshot =
      query.data ??
      createOptimisticPortfolioSnapshot(account as `0x${string}`);

    return mergeOptimisticPortfolioBuys(baseSnapshot, optimisticBuys);
  }, [account, enabled, optimisticBuys, query.data]);

  const hasOptimisticPositions =
    !query.data &&
    !!mergedSnapshot &&
    (mergedSnapshot.active.length > 0 || mergedSnapshot.settled.length > 0);

  return {
    account,
    isAuthenticated,
    snapshot: mergedSnapshot,
    loading: (query.isLoading || (query.isFetching && !query.data)) && !hasOptimisticPositions,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch
  };
}
