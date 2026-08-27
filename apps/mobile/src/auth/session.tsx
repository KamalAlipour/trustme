import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { authenticate, forgetSession, logout, refresh, request, setAccessToken, setSessionExpiredHandler } from '../api/client';
import type { AuthResponse, Member } from '../api/types';
import { hasStoredCredentials, saveCredentials } from '../lib/storage';
import { biometricAvailable, unlockPin } from '../lib/biometrics';

type SessionContextValue = {
  member: Member | null;
  ready: boolean;
  biometric: boolean;
  signIn: (phone: string, pin: string) => Promise<void>;
  signUp: (phone: string, pin: string, displayName?: string, email?: string) => Promise<AuthResponse>;
  signOut: () => Promise<void>;
  getStepUpPin: () => Promise<string | null>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [member, setMember] = useState<Member | null>(null);
  const [ready, setReady] = useState(false);
  const [biometric, setBiometric] = useState(false);

  useEffect(() => {
    setSessionExpiredHandler(() => setMember(null));
    let active = true;
    void (async () => {
      const available = await biometricAvailable().catch(() => false);
      if (active) setBiometric(available);
      let storedCredentials = false;
      try {
        storedCredentials = await hasStoredCredentials();
      } catch {
        storedCredentials = false;
      }
      if (storedCredentials) {
        try {
          const tokens = await refresh();
          if (active) {
            const response = await request<Member>('/v1/me');
            setMember(response);
            setAccessToken(tokens.accessToken);
          }
        } catch {
          await forgetSession().catch(() => undefined);
        }
      }
      if (active) setReady(true);
    })();
    return () => {
      active = false;
      setSessionExpiredHandler(undefined);
    };
  }, []);

  const value = useMemo<SessionContextValue>(() => ({
    member,
    ready,
    biometric,
    signIn: async (phone, pin) => {
      const result = await authenticate('/v1/auth/login', { phone, pin });
      await saveCredentials(result.tokens.refreshToken, pin);
      setMember(result.member);
    },
    signUp: async (phone, pin, displayName, email) => {
      const result = await authenticate('/v1/auth/register', {
        phone,
        pin,
        ...(displayName === undefined ? {} : { displayName }),
        ...(email === undefined ? {} : { email }),
      });
      await saveCredentials(result.tokens.refreshToken, pin);
      setMember(result.member);
      return result;
    },
    signOut: async () => {
      await logout();
      setMember(null);
    },
    getStepUpPin: async () => {
      try {
        return await unlockPin();
      } catch {
        return null;
      }
    },
  }), [biometric, member, ready]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
