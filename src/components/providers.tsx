"use client";

import { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { OnchainKitProvider } from "@coinbase/onchainkit";
import { base } from "wagmi/chains";
import { wagmiConfig } from "@/lib/wagmi";
import { useMiniAppReady } from "@/lib/use-farcaster-ready";

const queryClient = new QueryClient();

function FrameBoot() {
  useMiniAppReady();
  return null;
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider
          apiKey={process.env.NEXT_PUBLIC_ONCHAINKIT_API_KEY}
          chain={base}
          rpcUrl={process.env.NEXT_PUBLIC_BASE_RPC_URL}
          config={{
            appearance: {
              name: process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets"
            }
          }}
          miniKit={{
            enabled: true,
            autoConnect: false
          }}
        >
          <FrameBoot />
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
