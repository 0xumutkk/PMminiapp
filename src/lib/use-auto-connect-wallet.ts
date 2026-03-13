"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConnect } from "wagmi";
import { resolvePreferredConnector } from "@/lib/wallet/connector-preference";

export function useAutoConnectWallet() {
  const attemptedRef = useRef(false);
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();

  useEffect(() => {
    const connector = resolvePreferredConnector(connectors);

    if (attemptedRef.current || isConnected || !connector) {
      return;
    }

    attemptedRef.current = true;
    connect({ connector });
  }, [connect, connectors, isConnected]);
}
