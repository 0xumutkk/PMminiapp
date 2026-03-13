import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";
import { Attribution } from "ox/erc8021";
import type { EIP1193Provider } from "viem";

type MiniAppWindow = Window & {
  __swipenMiniAppEthereumProvider?: EIP1193Provider;
};

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Swipen";
const builderCode = process.env.NEXT_PUBLIC_BASE_BUILDER_CODE;
const dataSuffix = builderCode ? Attribution.toDataSuffix({ codes: [builderCode] }) : undefined;

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [base],
  connectors: [
    injected({
      target: {
        id: "farcaster-miniapp",
        name: "Mini App Wallet",
        provider(window) {
          return (window as MiniAppWindow | undefined)?.__swipenMiniAppEthereumProvider;
        }
      }
    }),
    baseAccount({ appName }),
    injected()
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org")
  },
  dataSuffix
});
