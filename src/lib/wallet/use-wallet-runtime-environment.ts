"use client";

import { useSyncExternalStore } from "react";
import { getWalletRuntimeEnvironment, type WalletRuntimeEnvironment } from "@/lib/wallet/connector-preference";

const WALLET_RUNTIME_EVENTS = [
  "ethereum#initialized",
  "swipen:wallet-provider-ready"
] as const;

const SERVER_SNAPSHOT: WalletRuntimeEnvironment = {
  hasInjectedProvider: false,
  isFramed: false
};

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleChange = () => {
    onStoreChange();
  };

  for (const eventName of WALLET_RUNTIME_EVENTS) {
    window.addEventListener(eventName, handleChange);
  }

  return () => {
    for (const eventName of WALLET_RUNTIME_EVENTS) {
      window.removeEventListener(eventName, handleChange);
    }
  };
}

export function useWalletRuntimeEnvironment() {
  return useSyncExternalStore(subscribe, getWalletRuntimeEnvironment, () => SERVER_SNAPSHOT);
}
