"use client";

import { useAccount, useChainId, useConnect } from "wagmi";
import { base } from "wagmi/chains";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletStatus() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending } = useConnect();

  if (isPending) {
    return <p className="wallet-status">Wallet: connecting...</p>;
  }

  if (!isConnected || !address) {
    const defaultConnector =
      connectors.find((connector) => connector.id === "injected" && connector.ready) ??
      connectors.find((connector) => connector.ready) ??
      connectors[0];

    if (!defaultConnector) {
      return <p className="wallet-status">Wallet: unavailable</p>;
    }

    return (
      <div className="wallet-status-group">
        <p className="wallet-status">Wallet: not connected</p>
        <button
          className="wallet-connect-btn"
          onClick={() => connect({ connector: defaultConnector })}
          type="button"
        >
          Connect
        </button>
      </div>
    );
  }

  const chainText = chainId === base.id ? "Base" : `Chain ${chainId}`;
  return <p className="wallet-status">{shortAddress(address)} · {chainText}</p>;
}
