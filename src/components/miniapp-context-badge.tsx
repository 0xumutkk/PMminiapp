"use client";

import { useMiniAppContext } from "@/lib/use-miniapp-context";

export function MiniAppContextBadge() {
  const { context, loaded, inMiniAppHost } = useMiniAppContext();

  if (!loaded) {
    return <p className="miniapp-badge">Detecting host...</p>;
  }

  if (!inMiniAppHost) {
    return <p className="miniapp-badge">Web preview</p>;
  }

  const name = context?.user?.username ?? context?.user?.displayName ?? "Base user";
  return <p className="miniapp-badge">Base App · @{name}</p>;
}
