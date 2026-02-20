import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import * as farcasterConnector from "@farcaster/frame-wagmi-connector";

const connectorFactory =
  (farcasterConnector as { farcasterFrame?: () => unknown }).farcasterFrame;

const farcasterMiniAppConnector = connectorFactory ? [connectorFactory() as never] : [];

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [...farcasterMiniAppConnector, injected()],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org")
  }
});
