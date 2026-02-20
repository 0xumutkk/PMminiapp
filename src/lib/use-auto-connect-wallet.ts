"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConnect } from "wagmi";

export function useAutoConnectWallet() {
  const attemptedRef = useRef(false);
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();

  useEffect(() => {
    if (attemptedRef.current || isConnected || connectors.length === 0) {
      return;
    }

    attemptedRef.current = true;
    connect({ connector: connectors[0] });
  }, [connect, connectors, isConnected]);
}
