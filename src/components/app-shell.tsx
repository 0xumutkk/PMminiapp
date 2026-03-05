"use client";

import { useState, useEffect } from "react";
import { MiniAppContextBadge } from "@/components/miniapp-context-badge";

type AppShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scrollContent?: boolean;
};

import Link from "next/link";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useMiniAppContext } from "@/lib/use-miniapp-context";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import { useRouter, usePathname } from "next/navigation";

export function AppShell({ title, subtitle, children, scrollContent = false }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const { address, isConnected, status: connectionStatus } = useAccount();
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { inMiniAppHost } = useMiniAppContext();
  const { isAuthenticated, status: authStatus, signIn, signOut } = useMiniAppAuth();

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
          height: '84px',
          gap: '20px'
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
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setShowDropdown(!showDropdown)}
                  className={`segmented-control__item ${pathname === "/profile" ? "segmented-control__item--active" : ""}`}
                  style={{
                    flexDirection: 'column',
                    gap: '1px',
                    height: '40px',
                    padding: '2px 16px',
                    border: 'none',
                    background: pathname === "/profile" ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
                    cursor: 'pointer'
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
                </button>

                {showDropdown && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 90 }}
                      onClick={() => setShowDropdown(false)}
                    />
                    <div style={{
                      position: 'absolute',
                      top: 'calc(100% + 8px)',
                      right: 0,
                      width: '160px',
                      background: 'rgba(12, 16, 20, 0.95)',
                      backdropFilter: 'blur(16px)',
                      borderRadius: '16px',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
                      overflow: 'hidden',
                      zIndex: 100,
                      display: 'flex',
                      flexDirection: 'column',
                      padding: '4px'
                    }}>
                      <Link
                        href="/profile"
                        onClick={() => setShowDropdown(false)}
                        style={{
                          padding: '12px 16px',
                          color: '#fff',
                          textDecoration: 'none',
                          fontSize: '14px',
                          fontWeight: 600,
                          borderRadius: '12px',
                          transition: 'background 0.2s',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)')}
                        onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.background = 'transparent')}
                      >
                        View Profile
                      </Link>
                      <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.1)', margin: '4px 8px' }} />
                      <button
                        onClick={() => {
                          void signOut();
                          disconnect();
                          setShowDropdown(false);
                          router.push('/markets');
                        }}
                        style={{
                          padding: '12px 16px',
                          color: '#ff3b6b',
                          background: 'transparent',
                          border: 'none',
                          textAlign: 'left',
                          fontSize: '14px',
                          fontWeight: '600',
                          cursor: 'pointer',
                          borderRadius: '12px',
                          transition: 'background 0.2s',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'rgba(255, 59, 107, 0.1)')}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'transparent')}
                      >
                        Sign Out
                      </button>
                    </div>
                  </>
                )}
              </div>
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
