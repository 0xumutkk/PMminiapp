"use client";

import { useState, useEffect } from "react";
import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { WalletStatusSlot } from "@/components/wallet-status-slot";

type AppShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scrollContent?: boolean;
};

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAccount, useConnect } from "wagmi";
import { useMiniAppContext } from "@/lib/use-miniapp-context";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";

export function AppShell({ title, subtitle, children, scrollContent = false }: AppShellProps) {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const { address, isConnected, status: connectionStatus } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { inMiniAppHost } = useMiniAppContext();
  const { isAuthenticated, status: authStatus, signIn } = useMiniAppAuth();

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleConnect = () => {
    // Priority: Farcaster (if in host) > Injected > First available
    const farcaster = connectors.find(c => c.id === 'farcaster');
    const injected = connectors.find(c => c.id === 'injected');

    const connector = inMiniAppHost ? (farcaster ?? injected ?? connectors[0]) : (injected ?? farcaster ?? connectors[0]);

    if (connector) {
      connect({ connector });
    }
  };

  const isActuallyConnected = mounted && isConnected && connectionStatus === 'connected';
  const isActuallyAuthenticated = mounted && isAuthenticated;
  const isAuthenticating = authStatus === "authenticating";

  return (
    <main className="app-shell">
      <header className="app-shell__top">
        <div style={{ width: '100%', height: '54px' }} /> {/* Status bar space */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          width: '100%',
          alignItems: 'center',
          padding: '0 20px',
          height: '84px'
        }}>
          <div className="segmented-control">
            <Link
              href="/markets"
              className={`segmented-control__item ${pathname === "/markets" ? "segmented-control__item--active" : ""}`}
            >
              Markets
            </Link>
            <Link
              href="/feed"
              className={`segmented-control__item ${pathname === "/feed" ? "segmented-control__item--active" : ""}`}
            >
              Feed
            </Link>
          </div>

          <div className="segmented-control">
            {!isActuallyConnected ? (
              <button
                className="segmented-control__item"
                onClick={handleConnect}
                disabled={isConnecting}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: isConnecting ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  opacity: isConnecting ? 0.6 : 1
                }}
              >
                {isConnecting ? 'Connecting...' : 'Connect'}
              </button>
            ) : !isActuallyAuthenticated ? (
              <button
                className="segmented-control__item"
                onClick={() => void signIn()}
                disabled={isAuthenticating}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: isAuthenticating ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  opacity: isAuthenticating ? 0.6 : 1
                }}
              >
                {isAuthenticating ? 'Signing in...' : 'Sign In'}
              </button>
            ) : (
              <Link
                href="/profile"
                className={`segmented-control__item ${pathname === "/profile" ? "segmented-control__item--active" : ""}`}
                style={{
                  flexDirection: 'column',
                  gap: '1px',
                  height: '40px',
                  padding: '2px 16px'
                }}
              >
                <span style={{ fontSize: '14px', lineHeight: '1.2' }}>Profile</span>
                {address && (
                  <span style={{
                    fontSize: '10px',
                    opacity: 0.5,
                    fontWeight: 500,
                    fontFamily: 'monospace',
                    letterSpacing: '0.02em',
                    lineHeight: '1'
                  }}>
                    {address.slice(0, 6)}...{address.slice(-4)}
                  </span>
                )}
              </Link>
            )}
          </div>
        </div>
      </header>

      <section className={`app-shell__content${scrollContent ? " app-shell__content--scroll" : ""}`}>
        {children}
      </section>
    </main>
  );
}
