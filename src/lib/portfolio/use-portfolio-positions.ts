"use client";

import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { useAccount } from "wagmi";

async function fetchPortfolioPositions(
  account: string,
  authHeaders: Record<string, string>
): Promise<PortfolioPositionsSnapshot> {
  const response = await fetch(`/api/portfolio/positions?account=${account}`, {
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
  const account = user?.address ?? address ?? null;
  const enabled = Boolean(account && isAuthenticated && isAddress(account));

  const query = useQuery({
    queryKey: ["portfolio-positions", account],
    queryFn: () => fetchPortfolioPositions(account as string, getAuthHeaders()),
    enabled,
    refetchInterval: enabled ? 20_000 : false
  });

  return {
    account,
    isAuthenticated,
    snapshot: query.data ?? null,
    loading: query.isLoading || (query.isFetching && !query.data),
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch
  };
}
