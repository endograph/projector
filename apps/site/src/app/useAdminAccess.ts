import { useConvexAuth } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";

const LAST_KNOWN_ADMIN_KEY = "projector:last-known-admin";

function readLastKnownAdmin(): boolean {
  try {
    return localStorage.getItem(LAST_KNOWN_ADMIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function useAdminAccess() {
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const liveAdmin = useQuery(api.dev.access.current, isAuthenticated ? {} : "skip");
  const [lastKnownAdmin, setLastKnownAdmin] = useState(readLastKnownAdmin);

  useEffect(() => {
    if (liveAdmin === undefined) return;
    const next = liveAdmin.isAdmin;
    setLastKnownAdmin(next);
    try {
      localStorage.setItem(LAST_KNOWN_ADMIN_KEY, next ? "1" : "0");
    } catch {}
  }, [liveAdmin]);

  // This cache only avoids a visual flash while auth and the authoritative
  // server query reconnect. A confirmed signed-out state never inherits it,
  // and every privileged Convex function still performs its own admin check.
  const isAdmin = liveAdmin?.isAdmin ?? (authLoading || isAuthenticated ? lastKnownAdmin : false);

  return { authLoading, isAuthenticated, isAdmin, liveAdmin };
}
