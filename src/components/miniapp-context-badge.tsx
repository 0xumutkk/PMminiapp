"use client";

import { useMiniAppContext } from "@/lib/use-miniapp-context";

export function MiniAppContextBadge() {
  const { context, loaded, inMiniAppHost } = useMiniAppContext();

  if (!loaded) {
    return <p className="miniapp-badge">Host: detecting...</p>;
  }

  if (!inMiniAppHost) {
    return <p className="miniapp-badge">Host: web browser</p>;
  }

  const name = context?.user?.displayName ?? context?.user?.username ?? "Base App user";
  return <p className="miniapp-badge">Host: Base App · {name}</p>;
}
