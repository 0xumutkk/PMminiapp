"use client";

import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import {
  fetchPortfolioPositions,
  getPortfolioPositionsQueryKey,
  PORTFOLIO_POSITIONS_STALE_TIME_MS
} from "@/lib/portfolio/use-portfolio-positions";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { isAddress } from "viem";
import { useAccount, useBalance } from "wagmi";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const PROFILE_WARMUP_DELAY_MS = 1200;

export function ProfileDataPrefetcher() {
  const { address } = useAccount();
  const { user, isAuthenticated, getAuthHeaders } = useMiniAppAuth();
  const queryClient = useQueryClient();
  const warmedAccountRef = useRef<string | null>(null);

  const account = address ?? user?.address ?? null;
  const shouldWarm = Boolean(account && isAuthenticated && isAddress(account));

  useBalance({
    address: shouldWarm ? (account as `0x${string}`) : undefined,
    token: USDC_ADDRESS,
    query: {
      enabled: shouldWarm,
      staleTime: PORTFOLIO_POSITIONS_STALE_TIME_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false
    }
  });

  useEffect(() => {
    if (!shouldWarm || !account) {
      warmedAccountRef.current = null;
      return;
    }

    const normalizedAccount = account.toLowerCase();
    const queryKey = getPortfolioPositionsQueryKey(account);
    const cached = queryClient.getQueryData(queryKey);
    if (cached || warmedAccountRef.current === normalizedAccount) {
      return;
    }

    const timer = window.setTimeout(() => {
      void queryClient
        .prefetchQuery({
          queryKey,
          queryFn: () => fetchPortfolioPositions(account, getAuthHeaders()),
          staleTime: PORTFOLIO_POSITIONS_STALE_TIME_MS
        })
        .then(() => {
          warmedAccountRef.current = normalizedAccount;
        })
        .catch((error) => {
          console.warn("[Profile Prefetch] Portfolio warmup failed:", error);
        });
    }, PROFILE_WARMUP_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [account, getAuthHeaders, queryClient, shouldWarm]);

  return null;
}
