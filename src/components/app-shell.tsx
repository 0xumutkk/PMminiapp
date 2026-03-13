"use client";

import { useState, useEffect } from "react";
import {
  formatWalletConnectError,
  getWalletConnectUnavailableReason,
  resolveFallbackConnector,
  resolvePreferredConnector
} from "@/lib/wallet/connector-preference";

type AppShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scrollContent?: boolean;
};

import Link from "next/link";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";
import { useRouter, usePathname } from "next/navigation";

export function AppShell({ title, subtitle, children, scrollContent = false }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [localConnectError, setLocalConnectError] = useState<string | null>(null);
  const { address, isConnected, status: connectionStatus } = useAccount();
  const { connectAsync, connectors, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { isAuthenticated, status: authStatus, signIn, signOut } = useMiniAppAuth();
  const selectedConnector = resolvePreferredConnector(connectors);
  const unavailableConnectError = mounted ? getWalletConnectUnavailableReason(connectors) : null;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Watchdog for hung connection
  useEffect(() => {
    const isAnyConnecting = isConnecting || connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
    if (isAnyConnecting && mounted) {
      const timer = setTimeout(() => {
        const stillConnecting = isConnecting || connectionStatus === 'connecting' || connectionStatus === 'reconnecting';
        if (stillConnecting) {
          console.warn("[AppShell] Connection seems hung (status:", connectionStatus, "), resetting...");
          disconnect();
        }
      }, 10_000);
      return () => clearTimeout(timer);
    }
  }, [isConnecting, connectionStatus, mounted, disconnect]);

  const displayConnectError =
    localConnectError ??
    unavailableConnectError ??
    (connectError ? formatWalletConnectError(connectError) : null);

  const handleConnect = async () => {
    console.log("[AppShell] Available connectors:", connectors.map(c => `${c.id} (${c.name})`));
    console.log("[AppShell] Attempting connect with:", selectedConnector?.id);

    if (!selectedConnector) {
      setLocalConnectError(unavailableConnectError);
      return;
    }

    setLocalConnectError(null);

    try {
      await connectAsync({ connector: selectedConnector });
    } catch (error) {
      const fallbackConnector = resolveFallbackConnector(
        selectedConnector.id,
        connectors,
        error
      );

      if (fallbackConnector && fallbackConnector.id !== selectedConnector.id) {
        try {
          await connectAsync({ connector: fallbackConnector });
          return;
        } catch (fallbackError) {
          setLocalConnectError(formatWalletConnectError(fallbackError));
          return;
        }
      }

      setLocalConnectError(formatWalletConnectError(error));
    }
  };

  const isActuallyConnected = mounted && isConnected && connectionStatus === 'connected';
  const isActuallyAuthenticated = mounted && isAuthenticated;
  const isAuthenticating = authStatus === "authenticating";
  const isAnyConnecting = (isConnecting || connectionStatus === 'connecting' || connectionStatus === 'reconnecting') && mounted;

  useEffect(() => {
    if (mounted) {
      console.log("[AppShell] State change:", {
        isActuallyConnected,
        connectionStatus,
        isConnected,
        isConnecting,
        isAnyConnecting,
        authStatus,
        isAuthenticated
      });
    }
  }, [mounted, isActuallyConnected, connectionStatus, isConnected, isConnecting, isAnyConnecting, authStatus, isAuthenticated]);

  return (
    <main className="app-shell">
      <header className="app-shell__top">
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
          {!mounted ? (
            <button className="segmented-control__item" style={{ border: 'none', background: 'none', fontWeight: 700 }}>
              Connect
            </button>
          ) : !isActuallyConnected ? (
            <div style={{ position: 'relative' }}>
              <button
                className="segmented-control__item"
                onClick={() => void handleConnect()}
                disabled={isAnyConnecting || !selectedConnector}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: isAnyConnecting || !selectedConnector ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                  opacity: isAnyConnecting || !selectedConnector ? 0.6 : 1
                }}
              >
                {isAnyConnecting ? 'Connecting...' : (displayConnectError ? 'Retry' : 'Connect')}
              </button>
              {isAnyConnecting && (
                <button
                  onClick={() => disconnect()}
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    background: 'none',
                    border: 'none',
                    color: 'rgba(255, 255, 255, 0.4)',
                    fontSize: '10px',
                    cursor: 'pointer',
                    padding: '4px'
                  }}
                >
                  Cancel
                </button>
              )}
              {displayConnectError && (
                <div style={{ position: 'absolute', top: '100%', right: 0, color: '#ff3b6b', fontSize: '10px', marginTop: '4px', whiteSpace: 'nowrap' }}>
                  {displayConnectError.slice(0, 54)}
                </div>
              )}
            </div>
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
                  background: pathname === "/profile" ? '#2a3143' : 'transparent',
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
                    top: 'calc(100% + 12px)',
                    right: '2px',
                    width: '130px',
                    background: 'rgba(0, 0, 0, 0.7)',
                    backdropFilter: 'blur(64px)',
                    WebkitBackdropFilter: 'blur(64px)',
                    borderRadius: '20px',
                    border: '1px solid rgba(255, 255, 255, 0.45)',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25)',
                    overflow: 'hidden',
                    zIndex: 100,
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '6px'
                  }}>
                    <Link
                      href="/profile"
                      onClick={() => setShowDropdown(false)}
                      style={{
                        padding: '10px 14px',
                        color: '#fff',
                        textDecoration: 'none',
                        fontSize: '14px',
                        fontWeight: 600,
                        borderRadius: '14px',
                        transition: 'background 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                      }}
                      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.15)')}
                      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.background = 'transparent')}
                    >
                      View Profile
                    </Link>
                    <div style={{ height: '1px', background: 'rgba(255, 255, 255, 0.2)', margin: '4px 8px' }} />
                    <button
                      onClick={() => {
                        void signOut();
                        disconnect();
                        setShowDropdown(false);
                        router.push('/markets');
                      }}
                      style={{
                        padding: '10px 14px',
                        color: '#ff3b6b',
                        background: 'transparent',
                        border: 'none',
                        textAlign: 'left',
                        fontSize: '14px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        borderRadius: '14px',
                        transition: 'background 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px'
                      }}
                      onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => (e.currentTarget.style.background = 'rgba(255, 59, 107, 0.15)')}
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
      </header>

      <section className={`app-shell__content${scrollContent ? " app-shell__content--scroll" : ""}`}>
        {children}
      </section>
    </main>
  );
}
