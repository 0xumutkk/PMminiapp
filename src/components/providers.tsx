"use client";

import { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { useMiniAppReady } from "@/lib/use-farcaster-ready";
import { MiniAppAuthProvider } from "@/components/miniapp-auth-provider";

const queryClient = new QueryClient();

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
