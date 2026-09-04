import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { BrowserProvider, Contract, JsonRpcProvider, MaxUint256, Wallet } from 'ethers';
import EthereumProvider from '@walletconnect/ethereum-provider';
import { ApiError, LockedError, request } from '../src/api/client';
import type { EscrowConfig, EscrowSettlement, EscrowWallet, WithdrawalQuote } from '../src/api/types';
import { useAvailability, useBalance, useEscrowBalance, useEscrowConfig, useEscrowSettlements, useEscrowUnloads, useIdentity, useInvalidateMoney } from '../src/hooks';
import { useSession } from '../src/auth/session';
import { Page, LoadingScreen } from '../src/components/Screen';
import { useTranslation } from '../src/i18n';
import { clearEscrowMnemonic, createInAppWallet, readEscrowMnemonic, saveEscrowMnemonic } from '../src/lib/escrow-wallet';
import { isValidRecoveryPhrase, normalizeRecoveryPhrase, parseRecoveryPhrase, parseUsdtAmount, randomVerificationWordIndices, shouldApproveAllowance, verifyMnemonicWords, withWalletConnectDeadline } from '../src/lib/escrow';
import { formatCoupons, formatDate, formatMicroUsdt } from '../src/lib/format';
import { mapApiError } from '../src/lib/errors';
import { colors, styles } from '../src/styles';
import { HeaderIcons } from '../src/components/HeaderIcons';

const ERC20_ABI = [
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
];
const ESCROW_ABI = ['function deposit(uint256 amount)'];

type WalletConnectSession = { provider: Awaited<ReturnType<typeof EthereumProvider.init>>; browser: BrowserProvider };

function RecoveryWords({ words }: { words: string[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {words.map((word, index) => (
        <View
          key={`${index}-${word}`}
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: 6,
            borderWidth: 1,
            borderRadius: 8,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderColor: colors.border,
            backgroundColor: colors.card,
          }}
        >
          <Text style={styles.muted}>{index + 1}</Text>
          <Text selectable style={{ ...styles.heading, fontWeight: '700' }}>{word}</Text>
        </View>
      ))}
    </View>
  );
}

export default function Tether() {
  const { t, language } = useTranslation();
  const { getStepUpPin } = useSession();
  const identity = useIdentity();
  const config = useEscrowConfig();
  const enabled = config.data?.enabled === true;
  const balance = useEscrowBalance(enabled);
  const settlements = useEscrowSettlements(enabled);
  const unloads = useEscrowUnloads(enabled);
  const moneyBalance = useBalance();
  const availability = useAvailability();
  const invalidate = useInvalidateMoney();
  const [wallet, setWallet] = useState<EscrowWallet | null>(null);
  const [draftWords, setDraftWords] = useState<string[] | null>(null);
  const [draftAddress, setDraftAddress] = useState('');
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [wordIndices, setWordIndices] = useState<[number, number] | null>(null);
  const [wordAnswers, setWordAnswers] = useState<[string, string]>(['', '']);
  const [writtenDown, setWrittenDown] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [revealedWords, setRevealedWords] = useState<string[] | null>(null);
  const [walletConnectSession, setWalletConnectSession] = useState<WalletConnectSession | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [unloadAmount, setUnloadAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [destination, setDestination] = useState('');
  const unloadPrefilled = useRef(false);
  const withdrawPrefilled = useRef(false);
  const destinationPrefilled = useRef(false);
  const connectCancel = useRef<((error: Error) => void) | null>(null);
  const [removeWalletConfirm, setRemoveWalletConfirm] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const showError = (text: string) => setFeedback({ text, kind: 'error' });
  const showSuccess = (text: string) => setFeedback({ text, kind: 'success' });
  const [withdrawalFeedback, setWithdrawalFeedback] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState('');
  const [eligibleAt, setEligibleAt] = useState<string | null>(null);
  const [withdrawalQuote, setWithdrawalQuote] = useState<WithdrawalQuote | null>(null);
  const [withdrawalQuoteError, setWithdrawalQuoteError] = useState('');
  const [withdrawalQuoteLoading, setWithdrawalQuoteLoading] = useState(false);


  useEffect(() => {
    if (balance.data?.primaryWallet !== undefined) setWallet(balance.data.primaryWallet);
  }, [balance.data?.primaryWallet]);
  useEffect(() => {
    if (unloadPrefilled.current) return;
    const available = balance.data?.availableMicroUsdt;
    if (available === undefined || BigInt(available) === 0n) return;
    setUnloadAmount(formatMicroUsdt(available, 'en'));
    unloadPrefilled.current = true;
  }, [balance.data?.availableMicroUsdt]);
  useEffect(() => {
    if (withdrawPrefilled.current) return;
    const available = availability.data?.availableToWithdrawCoupons;
    if (available === undefined || BigInt(available) === 0n) return;
    setWithdrawAmount(available);
    withdrawPrefilled.current = true;
  }, [availability.data?.availableToWithdrawCoupons]);
  useEffect(() => {
    if (destinationPrefilled.current) return;
    const address = wallet?.address;
    if (address === undefined || address.length === 0) return;
    setDestination(address);
    destinationPrefilled.current = true;
  }, [wallet?.address]);
  useEffect(() => {
    const amount = withdrawAmount.trim();
    if (amount.length === 0) {
      setWithdrawalQuote(null);
      setWithdrawalQuoteError('');
      setWithdrawalQuoteLoading(false);
      return;
    }
    setWithdrawalQuote(null);
    setWithdrawalQuoteError('');
    setWithdrawalQuoteLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void request<WithdrawalQuote>(`/v1/me/withdrawals/quote?couponsGross=${encodeURIComponent(amount)}`)
        .then((quote) => {
          if (!cancelled) setWithdrawalQuote(quote);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setWithdrawalQuoteError(cause instanceof ApiError ? cause.message : t.quoteUnavailable);
        })
        .finally(() => {
          if (!cancelled) setWithdrawalQuoteLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [withdrawAmount, t]);

  const shortAddress = useMemo(() => wallet === null ? '' : `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`, [wallet]);
  const availableMicroUsdt = BigInt(balance.data?.availableMicroUsdt ?? '0');
  const recoveryWordCount = useMemo(() => {
    const normalized = normalizeRecoveryPhrase(recoveryPhrase);
    return normalized === '' ? 0 : normalized.split(' ').length;
  }, [recoveryPhrase]);
  if (config.isLoading) return <LoadingScreen />;
  if (!config.data?.enabled) {
    return <Page><View style={styles.row}><Pressable onPress={() => router.back()}><Text style={styles.secondaryButtonText}>{t.escrow.back}</Text></Pressable><Text style={styles.title}>{t.escrow.title}</Text><HeaderIcons /></View><Text style={styles.muted}>{t.comingSoon}</Text></Page>;
  }

  const displayError = (cause: unknown, fallback = t.unknownError): string => {
    if (cause instanceof ApiError) return mapApiError(cause, t);
    const errorCode = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
    if (errorCode === 'INSUFFICIENT_FUNDS') return t.escrow.insufficientGas;
    if (errorCode === 'ACTION_REJECTED') return t.escrow.transactionRejected;
    if (errorCode === 'CALL_EXCEPTION') return t.escrow.transactionFailed;
    if (cause instanceof Error) {
      return cause.message;
    }
    return fallback;
  };
  const run = async (name: string, action: () => Promise<void>) => {
    setFeedback(null);
    setBusy(name);
    try {
      await action();
    } catch (cause) {
      showError(displayError(cause));
    } finally {
      setBusy('');
    }
  };
  const registerWallet = async (address: string, kind: 'IN_APP' | 'EXTERNAL') => {
    const registered = await request<EscrowWallet>('/v1/me/wallets', { method: 'POST', body: { address, kind } });
    setWallet(registered);
    await invalidate();
  };
  const createWallet = async () => {
    setFeedback(null);
    const created = createInAppWallet();
    const words = created.mnemonic?.phrase?.split(' ') ?? [];
    if (words.length !== 12) throw new Error('wallet mnemonic unavailable');
    setMnemonic(created.mnemonic?.phrase ?? null);
    setDraftWords(words);
    setDraftAddress(created.address);
    setWordIndices(await randomVerificationWordIndices(words.length));
    setWordAnswers(['', '']);
    setWrittenDown(false);
  };
  const clearDraft = () => {
    setDraftWords(null);
    setMnemonic(null);
    setDraftAddress('');
    setWordIndices(null);
    setWordAnswers(['', '']);
    setWrittenDown(false);
  };
  const discardDraft = () => {
    clearDraft();
    setFeedback(null);
  };
  const finishWallet = async () => {
    if (draftWords === null || mnemonic === null || wordIndices === null) return;
    if (!writtenDown) return;
    if (!verifyMnemonicWords(draftWords, wordIndices, wordAnswers)) {
      clearDraft();
      showError(t.escrow.recoveryMismatchRestart);
      return;
    }
    await run('wallet', async () => {
      await saveEscrowMnemonic(mnemonic);
      const persisted = await readEscrowMnemonic();
      if (persisted !== mnemonic) throw new Error(t.escrow.walletPersistenceFailed);
      await registerWallet(draftAddress, 'IN_APP');
      setDraftWords(null);
      setMnemonic(null);
      setWordIndices(null);
      setWordAnswers(['', '']);
      setWrittenDown(false);
      showSuccess(t.escrow.walletCreated);
    });
  };
  const importWallet = async () => {
    await run('import-wallet', async () => {
      if (!isValidRecoveryPhrase(recoveryPhrase)) {
        showError(t.escrow.importInvalidPhrase);
        return;
      }
      const phrase = parseRecoveryPhrase(recoveryPhrase);
      const imported = Wallet.fromPhrase(phrase);
      await saveEscrowMnemonic(phrase);
      const persisted = await readEscrowMnemonic();
      if (persisted !== phrase) throw new Error(t.escrow.walletPersistenceFailed);
      await registerWallet(imported.address, 'IN_APP');
      setRecoveryPhrase('');
      showSuccess(t.escrow.recoveryImported);
    });
  };
  const openWalletApp = async (uri: string): Promise<void> => {
    try {
      await Linking.openURL(uri);
    } catch {
      showError(t.escrow.walletAppMissing);
    }
  };
  const connectWallet = async () => {
    if (config.data.walletConnectProjectId === null) return;
    await run('connect-wallet', async () => {
      const provider = await EthereumProvider.init({
        projectId: config.data.walletConnectProjectId!,
        chains: [config.data.chainId],
        showQrModal: Platform.OS === 'web',
        metadata: {
          name: 'Trust Coupon',
          description: 'Trust Coupon',
          url: 'https://app-trustcoupon.komasi.as',
          icons: ['https://app-trustcoupon.komasi.as/favicon.ico'],
          redirect: { native: 'trustcoupon://', universal: 'https://app-trustcoupon.komasi.as' },
        },
      });
      const displayUriHandler = Platform.OS === 'web' ? null : (uri: string) => { void openWalletApp(uri); };
      if (displayUriHandler !== null) provider.on('display_uri', displayUriHandler);
      const attempt = withWalletConnectDeadline(() => provider.connect(), 120_000, () => new Error(t.escrow.connectTimeout));
      connectCancel.current = attempt.cancel;
      try {
        await attempt.done;
      } catch (cause) {
        await provider.disconnect().catch(() => {});
        throw cause;
      } finally {
        connectCancel.current = null;
        if (displayUriHandler !== null) provider.removeListener('display_uri', displayUriHandler);
      }
      const browser = new BrowserProvider(provider);
      const signer = await browser.getSigner();
      await registerWallet(await signer.getAddress(), 'EXTERNAL');
      setWalletConnectSession({ provider, browser });
    });
  };
  const cancelConnect = () => {
    connectCancel.current?.(new Error(t.escrow.connectCancelled));
  };
  const removeWallet = async () => {
    if (wallet === null) return;
    await run('remove-wallet', async () => {
      const pin = await getStepUpPin();
      if (!pin) throw new Error(t.escrow.stepUpRequired);
      await request(`/v1/me/wallets/${wallet.id}`, { method: 'DELETE', body: { pin } });
      if (walletConnectSession !== null) await walletConnectSession.provider.disconnect().catch(() => {});
      if (wallet.kind === 'IN_APP') await clearEscrowMnemonic();
      setWallet(null);
      setDraftWords(null);
      setDraftAddress('');
      setRecoveryPhrase('');
      setWordIndices(null);
      setWordAnswers(['', '']);
      setWrittenDown(false);
      setMnemonic(null);
      setRevealedWords(null);
      setWalletConnectSession(null);
      setTopUpAmount('');
      setUnloadAmount('');
      unloadPrefilled.current = false;
      setRemoveWalletConfirm(false);
      showSuccess(t.escrow.disconnected);
      await invalidate();
    });
  };
  const revealWallet = async () => {
    await run('reveal', async () => {
      const pin = await getStepUpPin();
      if (!pin) throw new Error(t.escrow.stepUpRequired);
      const stored = await readEscrowMnemonic();
      if (stored === null) throw new Error(t.escrow.walletNotFound);
      setRevealedWords(stored.split(' '));
    });
  };
  const sendTopUp = async () => {
    await run('topup', async () => {
      const amount = parseUsdtAmount(topUpAmount);
      const escrowConfig = config.data as EscrowConfig;
      if (escrowConfig.contractAddress === null || wallet === null) throw new Error(t.escrow.noWallet);
      let signer;
      if (wallet.kind === 'IN_APP') {
        if (escrowConfig.rpcUrl === null) throw new Error(t.escrow.publicRpcUnavailable);
        const stored = mnemonic ?? await readEscrowMnemonic();
        if (stored === null) throw new Error(t.escrow.walletNotFound);
        const localWallet = Wallet.fromPhrase(stored);
        signer = localWallet.connect(new JsonRpcProvider(escrowConfig.rpcUrl, escrowConfig.chainId));
      } else if (wallet.kind === 'EXTERNAL') {
        const session = walletConnectSession;
        if (session === null) throw new Error(t.escrow.connectWallet);
        signer = await session.browser.getSigner();
      } else {
        throw new Error(t.escrow.connectWallet);
      }
      const token = new Contract(escrowConfig.usdtAddress, ERC20_ABI, signer);
      const allowance = BigInt((await token.getFunction('allowance')(wallet.address, escrowConfig.contractAddress)).toString());
      if (shouldApproveAllowance(allowance, amount)) await (await token.getFunction('approve')(escrowConfig.contractAddress, MaxUint256)).wait();
      await (await new Contract(escrowConfig.contractAddress, ESCROW_ABI, signer).getFunction('deposit')(amount)).wait();
      setTopUpAmount('');
      showSuccess(t.escrow.topUpSubmitted);
      await invalidate();
    });
  };
  const requestUnload = async () => {
    await run('unload', async () => {
      const pin = await getStepUpPin();
      if (!pin) throw new Error(t.escrow.stepUpRequired);
      await request('/v1/me/escrow/unloads', { method: 'POST', body: { amount: unloadAmount, pin } });
      await invalidate();
    });
  };
  const updateWithdrawAmount = (value: string) => {
    const amount = value.replace(/\D/g, '');
    setWithdrawAmount(amount);
    setWithdrawalQuote(null);
    setWithdrawalQuoteError('');
    setWithdrawalQuoteLoading(amount.length > 0);
  };
  const withdraw = async () => {
    setFeedback(null);
    setWithdrawalFeedback(null);
    try {
      const stepUp = await getStepUpPin();
      if (!stepUp) return;
      const withdrawal = await request<{ eligibleAt: string }>('/v1/me/withdrawals', { method: 'POST', body: { destinationAddress: destination, couponsGross: withdrawAmount, pin: stepUp } });
      setEligibleAt(withdrawal.eligibleAt);
      setWithdrawalFeedback({ text: t.withdrawalSubmitted, kind: 'success' });
      await invalidate();
    } catch (cause) {
      setWithdrawalFeedback({
        text: cause instanceof LockedError ? `${cause.message} (${t.lockedSeconds(cause.retryAfter)})` : cause instanceof ApiError ? cause.message : t.unknownError,
        kind: 'error',
      });
    }
  };
  const copyAddress = async () => {
    if (wallet !== null) {
      await Clipboard.setStringAsync(wallet.address);
      showSuccess(t.escrow.addressCopied);
    }
  };
  const useFullAvailable = () => {
    setUnloadAmount(formatMicroUsdt(balance.data?.availableMicroUsdt ?? '0', 'en'));
    unloadPrefilled.current = true;
  };
  const publicRpcUnavailable = wallet?.kind === 'IN_APP' && config.data?.rpcUrl === null;
  const identityRequired = identity.data !== undefined && identity.data.status !== 'VERIFIED';

  return (
    <Page>
      <View style={styles.row}><Pressable onPress={() => router.back()}><Text style={styles.secondaryButtonText}>{t.escrow.back}</Text></Pressable><Text style={styles.title}>{t.escrow.title}</Text><HeaderIcons /></View>
      {identityRequired ? <View style={styles.card}>
        <Text style={styles.text}>{t.escrow.identityRequiredForTether}</Text>
        <Pressable onPress={() => router.push('/(tabs)/profile')} style={styles.button}>
          <Text style={styles.buttonText}>{t.openIdentityVerification}</Text>
        </Pressable>
      </View> : null}
      <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.locked}</Text>
        <Text style={styles.title}>{formatMicroUsdt(balance.data?.lockedMicroUsdt ?? '0', language)} USDT</Text>
        <Text style={styles.muted}>{t.escrow.available}: {formatMicroUsdt(balance.data?.availableMicroUsdt ?? '0', language)} USDT</Text>
        <Text style={styles.notice}>{t.escrow.confirmationNotice}</Text>
      </View>

      {!identityRequired ? <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.wallet}</Text>
        {wallet === null ? <Text style={styles.muted}>{t.escrow.noWallet}</Text> : <><Text style={styles.muted}>{t.escrow.walletAddress}: {shortAddress}</Text><Pressable onPress={() => void copyAddress()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.copyAddress}</Text></Pressable>{wallet.kind === 'IN_APP' ? <Pressable onPress={() => void revealWallet()} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.walletReveal}</Text></Pressable> : null}<Pressable onPress={() => setRemoveWalletConfirm(true)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.disconnectWallet}</Text></Pressable>{removeWalletConfirm ? <View style={styles.card}><Text style={styles.muted}>{wallet.kind === 'IN_APP' ? t.escrow.disconnectInAppWarning : t.escrow.disconnectExternalWarning}</Text><Pressable onPress={() => void removeWallet()} style={styles.button}><Text style={styles.buttonText}>{t.escrow.disconnectConfirm}</Text></Pressable><Pressable onPress={() => setRemoveWalletConfirm(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.cancel}</Text></Pressable></View> : null}</>}
        {Platform.OS === 'web' ? <Text style={styles.muted}>{t.escrow.webWalletWarning}</Text> : null}
        {draftWords !== null && wordIndices !== null ? <View style={styles.card}>{!writtenDown ? <><Text style={styles.text}>{t.escrow.recoveryWords}</Text><RecoveryWords words={draftWords} /><Pressable onPress={() => setWrittenDown(true)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.writtenDown}</Text></Pressable></> : <><Text style={styles.muted}>{t.escrow.verifyWords(wordIndices[0] + 1, wordIndices[1] + 1)}</Text><TextInput value={wordAnswers[0]} onChangeText={(value) => setWordAnswers([value, wordAnswers[1]])} placeholder={t.escrow.verifyWord(wordIndices[0] + 1)} style={styles.input} autoCapitalize="none" /><TextInput value={wordAnswers[1]} onChangeText={(value) => setWordAnswers([wordAnswers[0], value])} placeholder={t.escrow.verifyWord(wordIndices[1] + 1)} style={styles.input} autoCapitalize="none" /><Pressable onPress={() => void finishWallet()} style={styles.button}><Text style={styles.buttonText}>{t.escrow.verifyRecovery}</Text></Pressable><Pressable onPress={() => { setWrittenDown(false); setWordAnswers(['', '']); setFeedback(null); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.showWordsAgain}</Text></Pressable></>}<Pressable onPress={discardDraft} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.discardDraft}</Text></Pressable></View> : <>
          {wallet === null ? <><Pressable disabled={busy !== ''} onPress={() => void run('wallet', createWallet)} style={[styles.button, busy !== '' ? styles.buttonDisabled : null]}><Text style={styles.buttonText}>{t.escrow.createWallet}</Text></Pressable>{config.data.walletConnectProjectId !== null ? <Pressable disabled={busy !== ''} onPress={() => void connectWallet()} style={[styles.secondaryButton, busy !== '' ? styles.buttonDisabled : null]}><Text style={styles.secondaryButtonText}>{t.escrow.connectWallet}</Text></Pressable> : Platform.OS !== 'web' && config.data.walletConnectProjectId === null ? <Text style={styles.muted}>{t.escrow.nativeWalletNote}</Text> : null}</> : wallet.kind === 'EXTERNAL' && walletConnectSession === null && config.data.walletConnectProjectId !== null ? <Pressable disabled={busy !== ''} onPress={() => void connectWallet()} style={[styles.secondaryButton, busy !== '' ? styles.buttonDisabled : null]}><Text style={styles.secondaryButtonText}>{t.escrow.connectWallet}</Text></Pressable> : null}
          {busy === 'connect-wallet' ? <><Text style={styles.muted}>{t.escrow.connectPending}</Text><Pressable onPress={cancelConnect} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.cancelConnect}</Text></Pressable></> : null}
          <View style={styles.card}><Text style={styles.heading}>{t.escrow.importRecovery}</Text><TextInput value={recoveryPhrase} onChangeText={setRecoveryPhrase} placeholder={t.escrow.importRecoveryPlaceholder} style={styles.input} autoCapitalize="none" multiline />{recoveryWordCount > 0 && recoveryWordCount !== 12 ? <Text style={styles.muted}>{t.escrow.importWordCount(recoveryWordCount)}</Text> : null}<Pressable disabled={busy !== '' || recoveryWordCount !== 12} onPress={() => void importWallet()} style={[styles.secondaryButton, busy !== '' || recoveryWordCount !== 12 ? styles.buttonDisabled : null]}><Text style={styles.secondaryButtonText}>{t.escrow.importWallet}</Text></Pressable></View>
        </>}
        {revealedWords !== null ? <View style={styles.card}><Text style={styles.text}>{t.escrow.recoveryWords}</Text><RecoveryWords words={revealedWords} /><Pressable onPress={() => setRevealedWords(null)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.close}</Text></Pressable></View> : null}
        {busy === 'remove-wallet' ? <Text style={styles.muted}>{t.loading}</Text> : null}
        {feedback ? <Text style={feedback.kind === 'success' ? styles.notice : styles.danger}>{feedback.text}</Text> : null}
      </View> : null}

      {!identityRequired ? <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.topUp}</Text>
        <TextInput value={topUpAmount} onChangeText={setTopUpAmount} placeholder={t.escrow.topUpAmount} style={styles.input} keyboardType="decimal-pad" />
        <Text style={styles.muted}>{t.escrow.twoSignatureNotice}</Text>
        {publicRpcUnavailable ? <Text style={styles.danger}>{t.escrow.publicRpcUnavailable}</Text> : null}
        <Pressable disabled={busy !== '' || wallet === null || publicRpcUnavailable} onPress={() => void sendTopUp()} style={[styles.button, busy !== '' || wallet === null || publicRpcUnavailable ? styles.buttonDisabled : null]}><Text style={styles.buttonText}>{t.escrow.topUpButton}</Text></Pressable>
      </View> : null}

      {!identityRequired && (availableMicroUsdt > 0n || (unloads.data?.items ?? []).length > 0) ? <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.unload}</Text>
        {availableMicroUsdt > 0n ? <><TextInput value={unloadAmount} onChangeText={setUnloadAmount} placeholder={t.escrow.unloadAmount} style={styles.input} keyboardType="decimal-pad" />
        <Pressable onPress={useFullAvailable} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{t.escrow.useFullAvailable}</Text></Pressable>
        <Pressable disabled={busy !== ''} onPress={() => void requestUnload()} style={[styles.button, busy !== '' ? styles.buttonDisabled : null]}><Text style={styles.buttonText}>{t.escrow.unloadButton}</Text></Pressable></> : null}
        {(unloads.data?.items ?? []).slice(0, 3).map((item) => <Text key={item.id} style={item.status === 'CONFIRMED' ? styles.notice : item.status === 'FAILED' ? styles.danger : styles.muted}>{item.status === 'CONFIRMED' ? t.escrow.unloadConfirmed : item.status === 'FAILED' ? t.escrow.unloadFailed : t.escrow.unloadPending}: {item.amount} USDT</Text>)}
      </View> : null}

      <View style={styles.card}>
        <Text style={styles.heading}>{t.depositAddress}</Text>
        <Text selectable style={styles.text}>{moneyBalance.data?.depositAddress ?? t.notAssigned}</Text>
      </View>

      {availability.data && BigInt(availability.data.availableToWithdrawCoupons) > 0n ? <View style={styles.card}>
        <Text style={styles.heading}>{t.withdrawal}</Text>
        <Text style={styles.muted}>{t.withdrawCreditExplainer}</Text>
        <Text style={styles.text}>{t.totalCollateral}: {formatCoupons(availability.data.totalCollateralCoupons, language)}</Text>
        <Text style={styles.text}>{t.lockedGuarantee}: {formatCoupons(availability.data.lockedGuaranteeCoupons, language)}</Text>
        <Text style={styles.text}>{t.debt}: {formatCoupons(availability.data.outstandingDebtCoupons, language)}</Text>
        <Text style={styles.heading}>{t.availableToWithdraw}: {formatCoupons(availability.data.availableToWithdrawCoupons, language)}</Text>
        {availability.data.blockers.map((blocker) => <Text key={blocker} style={styles.danger}>{blocker === 'identity_unverified' ? t.identityWithdrawalRequired : blocker}</Text>)}
        <TextInput value={withdrawAmount} onChangeText={updateWithdrawAmount} placeholder={t.amount} style={styles.input} keyboardType="number-pad" />
        {withdrawalQuoteLoading ? <Text style={styles.muted}>{t.quoteLoading}</Text> : null}
        {withdrawalQuoteError ? <Text style={styles.danger}>{withdrawalQuoteError}</Text> : null}
        {withdrawalQuote ? <>
          <Text style={styles.text}>{t.platformFee}: {formatMicroUsdt(withdrawalQuote.feeMicroUsdt, language)} USDT</Text>
          <Text style={styles.heading}>{t.amountReceived}: {formatMicroUsdt(withdrawalQuote.netMicroUsdt, language)} USDT</Text>
        </> : null}
        <TextInput value={destination} onChangeText={setDestination} placeholder={t.destinationAddress} style={styles.input} />
        <Pressable disabled={withdrawalQuote === null || withdrawalQuoteLoading} onPress={() => void withdraw()} style={styles.button}><Text style={styles.buttonText}>{t.submitWithdrawal}</Text></Pressable>
        {eligibleAt ? <Text style={styles.muted}>{t.eligibleAt}: {formatDate(eligibleAt, language)}</Text> : null}
        {withdrawalFeedback ? <Text style={withdrawalFeedback.kind === 'success' ? styles.notice : styles.danger}>{withdrawalFeedback.text}</Text> : null}
      </View> : null}

      <View style={styles.card}>
        <Text style={styles.heading}>{t.escrow.history}</Text>
        {(settlements.data?.items ?? []).length === 0 ? <Text style={styles.muted}>{t.escrow.noHistory}</Text> : (settlements.data?.items ?? []).map((item: EscrowSettlement) => <View key={item.id} style={styles.card}><Text style={styles.text}>{item.amount} USDT · {item.role === 'BUYER' ? t.escrow.buyer : t.escrow.merchant}</Text><Text style={styles.muted}>{item.status} · {formatDate(item.createdAt, language)}</Text></View>)}
      </View>
      {feedback ? <Text style={feedback.kind === 'success' ? styles.notice : styles.danger}>{feedback.text}</Text> : null}
    </Page>
  );
}
