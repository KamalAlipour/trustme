import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authenticate, forgetSession, logout, refresh, request, setAccessToken, setSessionExpiredHandler, SessionExpiredError } from '../api/client';
import type { AuthResponse, Member, SecuritySetup } from '../api/types';
import { hasStoredCredentials, saveCredentials, saveCredentialsWithoutPin } from '../lib/storage';
import { biometricAvailable, unlockPin } from '../lib/biometrics';
import { isWebPlatform } from '../lib/platform';
import { getUnlockDecision } from './unlock-routing';

type SessionContextValue = {
  member: Member | null;
  setup: SecuritySetup | null;
  ready: boolean;
  biometric: boolean;
  unlockRequired: boolean;
  unlocking: boolean;
  unlockError: boolean;
  signIn: (phone: string, pin: string) => Promise<void>;
  signUp: (phone: string, pin: string, displayName?: string, email?: string) => Promise<AuthResponse>;
  signInWithSocial: (provider: 'google' | 'apple', idToken: string, displayName?: string) => Promise<void>;
  refreshSetup: () => Promise<SecuritySetup>;
  signOut: () => Promise<void>;
  getStepUpPin: () => Promise<string | null>;
  unlock: () => Promise<void>;
  continueWithPhoneLogin: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [member, setMember] = useState<Member | null>(null);
  const [setup, setSetup] = useState<SecuritySetup | null>(null);
  const [ready, setReady] = useState(false);
  const [biometric, setBiometric] = useState(false);
  const [unlockRequired, setUnlockRequired] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState(false);

  const restoreSession = useCallback(async () => {
    const tokens = await refresh();
    if (tokens.member !== undefined) setMember(tokens.member);
    const setupResponse = await request<SecuritySetup>('/v1/me/security-setup');
    setSetup(setupResponse);
    setAccessToken(tokens.accessToken);
  }, []);

  const unlock = useCallback(async () => {
    setUnlocking(true);
    setUnlockError(false);
    try {
      await restoreSession();
      setUnlockRequired(false);
      setReady(true);
    } catch (cause) {
      if (cause instanceof SessionExpiredError) {
        setUnlockRequired(false);
        setReady(true);
      } else {
        setUnlockRequired(true);
        setUnlockError(true);
      }
    } finally {
      setUnlocking(false);
    }
  }, [restoreSession]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setMember(null);
      setSetup(null);
    });
    let active = true;
    void (async () => {
      const available = await biometricAvailable().catch(() => false);
      if (!active) return;
      setBiometric(available);
      let storedCredentials = false;
      try {
        storedCredentials = await hasStoredCredentials();
      } catch {
        storedCredentials = false;
      }
      if (storedCredentials && !isWebPlatform()) {
        const decision = getUnlockDecision({
          storedSession: true,
          platform: 'native',
          biometricAvailable: available,
          refreshState: 'pending',
        });
        if (decision.screen === 'unlock') {
          setUnlockRequired(true);
          setReady(true);
          return;
        }
      }
      if (storedCredentials) {
        try {
          await restoreSession();
        } catch (cause) {
          if (!(cause instanceof SessionExpiredError)) setUnlockError(true);
        }
      }
      if (active) setReady(true);
    })();
    return () => {
      active = false;
      setSessionExpiredHandler(undefined);
    };
  }, [restoreSession]);

  const value = useMemo<SessionContextValue>(() => ({
    member,
    setup,
    ready,
    biometric,
    unlockRequired,
    unlocking,
    unlockError,
    signIn: async (phone, pin) => {
      const result = await authenticate('/v1/auth/login', { phone, pin });
      await saveCredentials(result.tokens.refreshToken, pin);
      setMember(result.member);
      setSetup(await request<SecuritySetup>('/v1/me/security-setup'));
      setUnlockRequired(false);
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
      setUnlockRequired(false);
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
      setSetup(null);
      setUnlockRequired(false);
    },
    getStepUpPin: async () => {
      try {
        return await unlockPin();
      } catch {
        return null;
      }
    },
    unlock,
    continueWithPhoneLogin: async () => {
      setUnlocking(true);
      try {
        await forgetSession();
        setMember(null);
        setSetup(null);
        setUnlockRequired(false);
        setUnlockError(false);
        setReady(true);
      } finally {
        setUnlocking(false);
      }
    },
  }), [biometric, member, ready, setup, unlock, unlocking, unlockError, unlockRequired]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
