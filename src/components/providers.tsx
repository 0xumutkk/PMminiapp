"use client";

import { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { useFarcasterReady } from "@/lib/use-farcaster-ready";

const queryClient = new QueryClient();

function FrameBoot() {
  useFarcasterReady();
  return null;
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <FrameBoot />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
