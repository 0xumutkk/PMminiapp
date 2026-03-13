"use client";

import { useAccount, useChainId, useConnect, useDisconnect } from "wagmi";
import { base } from "wagmi/chains";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import {
  resolveFallbackConnector,
  resolvePreferredConnector
} from "@/lib/wallet/connector-preference";
import { useWalletRuntimeEnvironment } from "@/lib/wallet/use-wallet-runtime-environment";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletStatus() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { connectAsync, connectors, isPending } = useConnect();
  const { isAuthenticated, status: authStatus, signIn, signOut } = useMiniAppAuth();
  const environment = useWalletRuntimeEnvironment();
  const defaultConnector = resolvePreferredConnector(connectors, environment);

  const handleConnect = async () => {
    if (!defaultConnector) {
      return;
    }

    try {
      await connectAsync({ connector: defaultConnector });
    } catch (error) {
      const fallbackConnector = resolveFallbackConnector(
        defaultConnector.id,
        connectors,
        error,
        environment
      );

      if (fallbackConnector && fallbackConnector.id !== defaultConnector.id) {
        try {
          await connectAsync({ connector: fallbackConnector });
        } catch {
          // Keep the secondary status widget silent on connection failures.
        }
      }
    }
  };

  if (isPending) {
    return <p className="wallet-status">Connecting wallet...</p>;
  }

  if (!isConnected || !address) {
    return (
      <button
        className="wallet-connect-btn"
        onClick={() => void handleConnect()}
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
