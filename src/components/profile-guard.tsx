"use client";

import { useAccount } from "wagmi";
import { useRouter } from "next/navigation";
import { useState, useEffect, ReactNode } from "react";
import { useMiniAppAuth } from "@/components/miniapp-auth-provider";

export function ProfileGuard({ children }: { children: ReactNode }) {
    const [mounted, setMounted] = useState(false);
    const { isConnected, isReconnecting, isConnecting, status: connectionStatus } = useAccount();
    const { isAuthenticated, status: authStatus } = useMiniAppAuth();
    const router = useRouter();

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        const isAuthPending = authStatus === "loading" || authStatus === "authenticating";
        if (mounted && !isAuthPending) {
            if (!isConnected && !isReconnecting && !isConnecting) {
                router.replace("/markets");
            } else if (isConnected && !isAuthenticated) {
                router.replace("/markets");
            }
        }
    }, [mounted, isConnected, isReconnecting, isConnecting, isAuthenticated, authStatus, router]);

    if (!mounted) return null;

    if (connectionStatus === 'connecting' || connectionStatus === 'reconnecting' || authStatus === "loading") {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'rgba(255, 255, 255, 0.45)'
            }}>
                Verifying account...
            </div>
        );
    }

    if (!isConnected || !isAuthenticated) {
        return (
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'rgba(255, 255, 255, 0.45)'
            }}>
                Authentication required. Redirecting...
            </div>
        );
    }

    return <>{children}</>;
}
