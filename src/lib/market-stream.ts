import { EventEmitter } from "node:events";
import { MarketSnapshot } from "@/lib/market-types";

const MARKETS_EVENT = "markets";

type MarketEmitter = EventEmitter & {
  emit(event: "markets", snapshot: MarketSnapshot): boolean;
  on(event: "markets", listener: (snapshot: MarketSnapshot) => void): MarketEmitter;
  off(event: "markets", listener: (snapshot: MarketSnapshot) => void): MarketEmitter;
};

declare global {
  var __marketEmitter: MarketEmitter | undefined;
}

function getEmitter() {
  if (!globalThis.__marketEmitter) {
    globalThis.__marketEmitter = new EventEmitter() as MarketEmitter;
  }

  return globalThis.__marketEmitter;
}

export function publishMarketSnapshot(snapshot: MarketSnapshot) {
  getEmitter().emit(MARKETS_EVENT, snapshot);
}

export function subscribeMarketSnapshot(listener: (snapshot: MarketSnapshot) => void) {
  const emitter = getEmitter();
  emitter.on(MARKETS_EVENT, listener);

  return () => {
    emitter.off(MARKETS_EVENT, listener);
  };
}
