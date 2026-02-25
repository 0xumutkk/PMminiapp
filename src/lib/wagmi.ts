import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [base],
  connectors: [
    farcasterMiniApp(), // Base App / Farcaster host wallet – use first when embedded
    injected() // Browser extension (MetaMask etc.) – fallback for dev / web
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org")
  }
});
