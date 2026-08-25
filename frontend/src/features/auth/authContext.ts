import { createContext } from 'react';
import type { AuthUser, UserRole } from './types';

export interface AuthContextValue {
  user: AuthUser | null;
  /** True until the stored token has been checked against the API. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => void;
  /** Role check used to hide actions the caller cannot perform. */
  can: (...roles: UserRole[]) => boolean;
}

/** Kept in a non-component module so AuthProvider.tsx stays fast-refresh friendly. */
export const AuthContext = createContext<AuthContextValue | null>(null);
