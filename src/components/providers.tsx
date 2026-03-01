"use client";

import { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { useMiniAppReady } from "@/lib/use-farcaster-ready";
import { MiniAppAuthProvider } from "@/components/miniapp-auth-provider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

function FrameBoot() {
  useMiniAppReady();
  return null;
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <FrameBoot />
        <MiniAppAuthProvider>{children}</MiniAppAuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
