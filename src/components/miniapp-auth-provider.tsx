"use client";

import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { requestMiniAppSignIn } from "@/lib/miniapp-sdk-safe";

type MiniAppAuthUser = {
  fid: number;
  address: string;
  expiresAt: string;
};

type MiniAppAuthStatus = "loading" | "guest" | "authenticating" | "authenticated";

type SessionResponse =
  | {
      authenticated: false;
    }
  | {
      authenticated: true;
      user: MiniAppAuthUser;
      token?: string;
    };

type MiniAppAuthContextValue = {
  status: MiniAppAuthStatus;
  user: MiniAppAuthUser | null;
  error: string | null;
  isAuthenticated: boolean;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
  getAuthHeaders: () => Record<string, string>;
};

const MiniAppAuthContext = createContext<MiniAppAuthContextValue | null>(null);
const AUTH_BEARER_STORAGE_KEY = "miniapp_auth_bearer";

function readStoredBearerToken() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const token = window.sessionStorage.getItem(AUTH_BEARER_STORAGE_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function persistBearerToken(token: string | null) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (token) {
      window.sessionStorage.setItem(AUTH_BEARER_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(AUTH_BEARER_STORAGE_KEY);
    }
  } catch {
    // Ignore storage access errors in restrictive webviews.
  }
}

function errorToMessage(error: unknown): string {
  let message = "";
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      message = record.message;
    }
  }
  if (!message && error instanceof Error) {
    message = error.message;
  }
  if (!message) {
    return "Authentication failed";
  }

  if (message.toLowerCase().includes("valid fid") || message.toLowerCase().includes("fid is required")) {
    return "Sign in requires a Farcaster account. Open this app from Base App while logged in to your Farcaster account. Some preview tools may not support sign-in.";
  }

  if (message.toLowerCase().includes("invalid_nonce") || message.toLowerCase().includes("nonce")) {
    return "Sign-in session expired. Please try again.";
  }

  if (message.toLowerCase().includes("invalid_signature")) {
    return "Signature verification failed. Please try signing in again.";
  }

  if (message.toLowerCase().includes("mini app sdk unavailable")) {
    return "Sign in is only available inside Base App.";
  }

  return message;
}

async function parseSessionResponse(response: Response) {
  const body = (await response.json().catch(() => null)) as
    | (SessionResponse & { error?: string })
    | null;

  if (!response.ok) {
    const message = body && typeof body.error === "string" ? body.error : "Authentication request failed";
    throw new Error(message);
  }

  if (!body) {
    throw new Error("Authentication response is empty");
  }

  return body;
}

async function fetchSiwfNonce(): Promise<string> {
  const res = await fetch("/api/auth/nonce", { method: "POST", credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to get sign-in nonce");
  }
  const data = (await res.json()) as { nonce?: string };
  if (!data?.nonce) {
    throw new Error("Invalid nonce response");
  }
  return data.nonce;
}

export function MiniAppAuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<MiniAppAuthStatus>("loading");
  const [user, setUser] = useState<MiniAppAuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const tokenRef = useRef<string | null>(null);

  const getAuthHeaders = useCallback(() => {
    const headers: Record<string, string> = {};
    const t = tokenRef.current;
    if (t) {
      headers.Authorization = `Bearer ${t}`;
    }
    return headers;
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/session", {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: getAuthHeaders()
      });

      if (response.status === 401) {
        setUser(null);
        setStatus("guest");
        setError(null);
        tokenRef.current = null;
        persistBearerToken(null);
        return;
      }

      const payload = await parseSessionResponse(response);

      if (!payload.authenticated) {
        setUser(null);
        setStatus("guest");
        setError(null);
        tokenRef.current = null;
        persistBearerToken(null);
        return;
      }

      if (payload.token) {
        tokenRef.current = payload.token;
        persistBearerToken(payload.token);
      }
      setUser(payload.user);
      setStatus("authenticated");
      setError(null);
    } catch (refreshError) {
      setUser(null);
      setStatus("guest");
      setError(errorToMessage(refreshError));
      tokenRef.current = null;
      persistBearerToken(null);
    }
  }, [getAuthHeaders]);

  useEffect(() => {
    tokenRef.current = readStoredBearerToken();
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) {
      return;
    }
    void refreshSession();
  }, [refreshSession, storageReady]);

  const signIn = useCallback(async () => {
    setError(null);

    setStatus("authenticating");
    try {
      const nonce = await fetchSiwfNonce();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      const signInResult = await requestMiniAppSignIn({
        nonce,
        expirationTime: expiresAt,
        acceptAuthAddress: true
      });

      if (!signInResult) {
        throw new Error("Sign in request was rejected");
      }

      const response = await fetch("/api/auth/siwf", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: signInResult.message,
          signature: signInResult.signature
        })
      });

      const payload = await parseSessionResponse(response);
      if (!payload.authenticated) {
        throw new Error("Authentication failed");
      }

      if (payload.token) {
        tokenRef.current = payload.token;
        persistBearerToken(payload.token);
      }
      setUser(payload.user);
      setStatus("authenticated");
      setError(null);
      return true;
    } catch (signInError) {
      setUser(null);
      setStatus("guest");
      setError(errorToMessage(signInError));
      return false;
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    tokenRef.current = null;
    persistBearerToken(null);
    try {
      await fetch("/api/auth/session", {
        method: "DELETE",
        credentials: "include"
      });
    } catch {
      // Ignore sign-out network errors; local state still resets.
    }

    setUser(null);
    setStatus("guest");
  }, []);

  const value = useMemo<MiniAppAuthContextValue>(
    () => ({
      status,
      user,
      error,
      isAuthenticated: status === "authenticated" && Boolean(user),
      signIn,
      signOut,
      refreshSession,
      getAuthHeaders
    }),
    [error, getAuthHeaders, refreshSession, signIn, signOut, status, user]
  );

  return <MiniAppAuthContext.Provider value={value}>{children}</MiniAppAuthContext.Provider>;
}

export function useMiniAppAuth() {
  const value = useContext(MiniAppAuthContext);
  if (!value) {
    throw new Error("useMiniAppAuth must be used within MiniAppAuthProvider");
  }

  return value;
}
