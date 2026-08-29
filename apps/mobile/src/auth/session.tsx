import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { authenticate, forgetSession, logout, refresh, request, setAccessToken, setSessionExpiredHandler } from '../api/client';
import type { AuthResponse, Member, SecuritySetup } from '../api/types';
import { hasStoredCredentials, saveCredentials, saveCredentialsWithoutPin } from '../lib/storage';
import { biometricAvailable, unlockPin } from '../lib/biometrics';

type SessionContextValue = {
  member: Member | null;
  setup: SecuritySetup | null;
  ready: boolean;
  biometric: boolean;
  signIn: (phone: string, pin: string) => Promise<void>;
  signUp: (phone: string, pin: string, displayName?: string, email?: string) => Promise<AuthResponse>;
  signInWithSocial: (provider: 'google' | 'apple', idToken: string, displayName?: string) => Promise<void>;
  refreshSetup: () => Promise<SecuritySetup>;
  signOut: () => Promise<void>;
  getStepUpPin: () => Promise<string | null>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [member, setMember] = useState<Member | null>(null);
  const [setup, setSetup] = useState<SecuritySetup | null>(null);
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
            if (tokens.member !== undefined) setMember(tokens.member);
            const setupResponse = await request<SecuritySetup>('/v1/me/security-setup');
            setSetup(setupResponse);
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
    setup,
    ready,
    biometric,
    signIn: async (phone, pin) => {
      const result = await authenticate('/v1/auth/login', { phone, pin });
      await saveCredentials(result.tokens.refreshToken, pin);
      setMember(result.member);
      setSetup(await request<SecuritySetup>('/v1/me/security-setup'));
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
      setSetup(await request<SecuritySetup>('/v1/me/security-setup'));
      return result;
    },
    signInWithSocial: async (provider, idToken, displayName) => {
      const result = await authenticate(`/v1/auth/${provider}`, {
        idToken,
        ...(displayName === undefined ? {} : { displayName }),
      });
      await saveCredentialsWithoutPin(result.tokens.refreshToken);
      setMember(result.member);
      setSetup(await request<SecuritySetup>('/v1/me/security-setup'));
    },
    refreshSetup: async () => {
      const result = await request<SecuritySetup>('/v1/me/security-setup');
      setSetup(result);
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
  }), [biometric, member, ready, setup]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
