import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, TOKEN_STORAGE_KEY } from '@/services/api';
import type { AuthResponse, AuthUser, UserRole } from './types';
import { AuthContext } from './authContext';


function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage blocked — the session still works until reload.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  // A stored token may be expired or issued by a different backend, so it's
  // only trusted once /me confirms it. Anything else clears it rather than
  // leaving the UI in a half-authenticated state.
  useEffect(() => {
    if (!readToken()) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    api
      .get<AuthUser>('/auth/me')
      .then((res) => {
        if (!cancelled) setUser(res.data);
      })
      .catch(() => {
        writeToken(null);
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyAuth = useCallback(
    (data: AuthResponse) => {
      writeToken(data.token);
      setUser(data.user);
      // Cached lists were fetched anonymously; refetch them as this user.
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<AuthResponse>('/auth/login', { email, password });
      applyAuth(res.data);
    },
    [applyAuth],
  );

  const register = useCallback(
    async (email: string, name: string, password: string) => {
      const res = await api.post<AuthResponse>('/auth/register', { email, name, password });
      applyAuth(res.data);
    },
    [applyAuth],
  );

  const logout = useCallback(() => {
    writeToken(null);
    setUser(null);
    void queryClient.invalidateQueries();
  }, [queryClient]);

  const can = useCallback(
    (...roles: UserRole[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const value = useMemo(
    () => ({ user, isLoading, login, register, logout, can }),
    [user, isLoading, login, register, logout, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
