"use client";

import { useAccount, useChainId, useConnect, useDisconnect } from "wagmi";
import { base } from "wagmi/chains";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";

function resolvePreferredConnector(connectors: ReturnType<typeof useConnect>["connectors"]) {
  const baseAccount = connectors.find((c) => c.id === "baseAccount");
  const injected = connectors.find((c) => c.id === "injected");

  return baseAccount ?? injected ?? connectors[0];
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletStatus() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();
  const { isAuthenticated, status: authStatus, signIn, signOut } = useMiniAppAuth();
  const defaultConnector = resolvePreferredConnector(connectors);

  if (isPending) {
    return <p className="wallet-status">Connecting wallet...</p>;
  }

  if (!isConnected || !address) {
    return (
      <button
        className="wallet-connect-btn"
        onClick={() => connect({ connector: defaultConnector })}
        disabled={!defaultConnector}
        type="button"
      >
        Connect Wallet
      </button>
    );
  }

  if (authStatus === "authenticating") {
    return <p className="wallet-status">Signing in...</p>;
  }

  if (authStatus === "loading") {
    return <p className="wallet-status">Checking session...</p>;
  }

  if (!isAuthenticated) {
    return (
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="wallet-connect-btn" onClick={() => void signIn()} type="button">
          Sign In
        </button>
        <button className="wallet-connect-btn" onClick={() => disconnect()} type="button">
          ×
        </button>
      </div>
    );
  }

  const chainText = chainId === base.id ? "Base" : `Chain ${chainId}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <p className="wallet-status" style={{ margin: 0 }}>{shortAddress(address)} · {chainText}</p>
      <button
        className="wallet-connect-btn"
        style={{ minWidth: 'unset', padding: '6px 10px' }}
        onClick={() => {
          void signOut();
          disconnect();
        }}
      >
        Out
      </button>
    </div>
  );
}
