import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { injected } from "@wagmi/core";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { Attribution } from "ox/erc8021";

// 1. Check for builder code in environment variables
const builderCode = process.env.NEXT_PUBLIC_BASE_BUILDER_CODE;

// 2. Generate dataSuffix if a code is present
const dataSuffix = builderCode ? Attribution.toDataSuffix({ codes: [builderCode] }) : undefined;

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [base],
  connectors: [
    farcasterMiniApp(), // Base App / Farcaster host wallet – use first when embedded
    injected() // Browser extension (MetaMask etc.) – fallback for dev / web
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org")
  },
  // 3. Attach standard ERC-8021 dataSuffix to all outgoing transactions
  dataSuffix
});
