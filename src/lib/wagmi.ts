import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";
import { Attribution } from "ox/erc8021";

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Swipen";
const builderCode = process.env.NEXT_PUBLIC_BASE_BUILDER_CODE;
const dataSuffix = builderCode ? Attribution.toDataSuffix({ codes: [builderCode] }) : undefined;

export const wagmiConfig = createConfig({
  ssr: true,
  chains: [base],
  connectors: [
    baseAccount({ appName }),
    injected()
  ],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org")
  },
  dataSuffix
});
