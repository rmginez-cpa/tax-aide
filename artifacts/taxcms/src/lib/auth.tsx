import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { type User, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

interface AuthContextType {
  /** The signed-in user, or null when signed out / session expired. */
  user: User | null;
  /** True only while the first /auth/me request is in flight. */
  isLoading: boolean;
  /** Forget the signed-in user locally (call after POST /auth/logout succeeds). */
  logout: () => void;
  /** Store the user returned by POST /auth/login so protected routes see it immediately. */
  signIn: (user: User) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  logout: () => {},
  signIn: () => {},
});

/** react-query key of the cached current user (GET /api/auth/me). */
export const ME_QUERY_KEY = getGetMeQueryKey();

/** The cached signed-in user, if any (read outside React, e.g. in QueryCache callbacks). */
export function getCachedUser(queryClient: QueryClient): User | null {
  return (queryClient.getQueryData<User | null>(ME_QUERY_KEY) ?? null) as User | null;
}

/** Mark the session as ended: routing then sends the user to /login. */
export function clearCachedUser(queryClient: QueryClient): void {
  queryClient.setQueryData(ME_QUERY_KEY, null);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: user, isLoading } = useGetMe({
    query: {
      retry: false,
      staleTime: Infinity,
      queryKey: ME_QUERY_KEY,
    },
  });

  const logout = useCallback(() => clearCachedUser(queryClient), [queryClient]);

  const signIn = useCallback((u: User) => {
    // Drop anything cached for a previous session so another account's data never flashes.
    queryClient.removeQueries({
      predicate: q => q.queryKey[0] !== ME_QUERY_KEY[0] && q.queryKey[0] !== AUTH_CONFIG_QUERY_KEY[0],
    });
    queryClient.setQueryData(ME_QUERY_KEY, u);
  }, [queryClient]);

  const value = useMemo(
    () => ({ user: user || null, isLoading, logout, signIn }),
    [user, isLoading, logout, signIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/** Public auth settings from GET /api/auth/config. */
export interface AuthConfig {
  /** Whether the demo accounts are seeded (and the login page may show them). */
  demoAccounts: boolean;
}

/** react-query key of GET /api/auth/config. */
export const AUTH_CONFIG_QUERY_KEY = ["/api/auth/config"] as const;

/**
 * Public auth configuration, fetched once and cached for the session. While loading, or if the
 * server does not answer, `demoAccounts` is false so demo credentials are never shown by mistake.
 */
export function useAuthConfig(): { config: AuthConfig; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: AUTH_CONFIG_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<Partial<AuthConfig>>("/auth/config", { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return { config: { demoAccounts: data?.demoAccounts === true }, isLoading };
}
