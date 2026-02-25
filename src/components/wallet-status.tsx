"use client";

import { useAccount, useChainId, useConnect } from "wagmi";
import { base } from "wagmi/chains";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import { useMiniAppContext } from "@/lib/use-miniapp-context";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletStatus() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { isAuthenticated, status: authStatus, signIn } = useMiniAppAuth();
  const { inMiniAppHost } = useMiniAppContext();

  if (isPending) {
    return <p className="wallet-status">Connecting wallet...</p>;
  }

  if (!isConnected || !address) {
    const defaultConnector = inMiniAppHost
      ? connectors.find((c) => c.id === "farcaster" && c.ready) ??
        connectors.find((c) => c.ready) ??
        connectors[0]
      : connectors.find((c) => c.id === "injected" && c.ready) ??
        connectors.find((c) => c.ready) ??
        connectors[0];

    if (!defaultConnector) {
      return <p className="wallet-status">Wallet unavailable</p>;
    }

    return (
      <button
        className="wallet-connect-btn"
        onClick={() => connect({ connector: defaultConnector })}
        type="button"
      >
        Connect Wallet
      </button>
    );
  }

  if (authStatus === "authenticating") {
    return <p className="wallet-status">Signing in...</p>;
  }

  if (!isAuthenticated) {
    return (
      <button className="wallet-connect-btn" onClick={() => void signIn()} type="button">
        Sign in
      </button>
    );
  }

  const chainText = chainId === base.id ? "Base" : `Chain ${chainId}`;
  return <p className="wallet-status">{shortAddress(address)} · {chainText}</p>;
}
