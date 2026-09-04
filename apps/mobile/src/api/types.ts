export type Member = {
  id: string;
  displayName: string | null;
  barcodeId: string;
  country: string | null;
  phone: string | null;
  email: string | null;
  emailVerified: boolean;
  kycStatus: string;
  activeGuaranteeCount: number;
  isRestricted: boolean;
  commission: {
    rateBps: number;
    floorBps: number;
    networkAverageBps: number;
    marketer: { barcodeId: string; displayName: string | null } | null;
    dispute: { strikes: number; lastStrikeAt: string; status: string; nextStrikeAt: string; autoResolveAt: string } | null;
  };
  identityVerification: {
    status: 'UNVERIFIED' | 'VERIFIED' | 'MISMATCH' | 'INCONCLUSIVE';
    verifiedAt: string | null;
    mode?: 'AUTOMATED' | 'MANUAL' | null;
    provider?: string | null;
  };
};

export type Tokens = {
  accessToken: string;
  expiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

export type AuthResponse = { tokens: Tokens; member: Member };
export type SecuritySetup = {
  emailVerified: boolean;
  biometricEnrolled: boolean;
  biometricPending: boolean;
  requiresEmailVerification: boolean;
  remaining: Array<'pin' | 'email_verification' | 'biometric_enrolment'>;
  completedAt: string | null;
};
export type Balance = { barcodeId: string; coupons: string; dustMicroUsdt: string; depositAddress: string | null };
export type BarcodeResult = { barcodeId: string; displayName: string | null; isDemo: boolean };
export type BarcodeDetail = BarcodeResult & { kycStatus: string };
export type Transaction = {
  id: string;
  transactionId: string;
  refundableTransactionId: string | null;
  direction: 'in' | 'out';
  amountCoupons: string;
  counterparty: { displayName?: string | null; barcodeId?: string; systemAccountType?: string };
  refund: { id: string; status: string; amountCoupons: string } | null;
  transaction: { type: string; status: string; createdAt: string };
};
export type TransactionsPage = { items: Transaction[]; nextCursor: string | null };
export type MediaKind = 'AUDIO' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
export type MediaAsset = { id: string; kind: MediaKind; mimeType: string; byteSize: number };
export type RefundRequest = {
  id: string;
  amountCoupons: string;
  reason: string;
  status: string;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  counterparty: { displayName: string | null; barcodeId: string };
  originalAmountCoupons: string;
  originalTransactionDate: string;
  refundableAmountCoupons: string;
  mediaIds: string[];
};
export type Charity = { id: string; name: string; description: string | null };
export type AidRequest = {
  id: string;
  charityId: string;
  charityName?: string;
  applicant?: { displayName: string | null; barcodeId: string };
  amountCoupons: string;
  approvedCoupons: string | null;
  description: string;
  status: string;
  decisionNote: string | null;
  decidedById: string | null;
  disbursementTransactionId: string | null;
  guaranteeId: string | null;
  loan: { id: string; principalCoupons: string; outstandingCoupons: string; status: string } | null;
  createdAt: string;
  decidedAt: string | null;
  mediaIds: string[];
};
export type Contact = { id: string; alias: string; barcodeId: string; displayName: string | null; lastActivityAt: string | null; createdAt: string };
export type LoanInstallment = { id: string; sequence: number; dueAt: string; amountCoupons: string; paidCoupons: string; paidAt: string | null };
export type Guarantee = { id: string; loanId: string; guarantorId: string; amountCoupons: string; status: string; wrongAttempts: number; lockedAt: string | null; activatedAt: string | null; resolvedAt: string | null; guarantor?: { displayName: string | null; barcodeId: string } };
export type Loan = {
  id: string;
  borrowerId: string;
  lenderId: string | null;
  requestedLenderId: string | null;
  requestedLender: { displayName: string | null; barcodeId: string } | null;
  borrower: { displayName: string | null; barcodeId: string } | null;
  description: string | null;
  principalCoupons: string;
  outstandingCoupons: string;
  status: string;
  createdAt: string;
  fundedAt: string | null;
  settledAt: string | null;
  mediaIds: string[];
  installments: LoanInstallment[];
  guarantees: Guarantee[];
};
export type WithdrawalAvailability = {
  lockedGuaranteeCoupons: string;
  outstandingDebtCoupons: string;
  totalCollateralCoupons: string;
  availableToWithdrawCoupons: string;
  blockers: string[];
};
export type Country = { code: string; name: string };
export type IdentityReview = { status: 'PENDING' | 'APPROVED' | 'REJECTED'; submittedAt: string; decidedAt: string | null; decisionNote: string | null };
export type IdentityInfo = { country: string | null; mode: 'AUTOMATED' | 'MANUAL' | null; provider: string | null; providerLabel: string | null; plannedProviderLabel: string | null; status: string; verifiedAt: string | null; iban: string | null; ibanVerifiedAt: string | null; requiredForWithdrawal: boolean; review: IdentityReview | null };
export type BalanceDisclosure = { id: string; code: string; requestedAt: string; expiresAt: string };
export type Withdrawal = { id: string; status: string; couponsGross: string; grossUsdt: string; feeUsdt: string; netUsdt: string; chainTxHash: string | null; eligibleAt: string };
export type WithdrawalQuote = {
  grossMicroUsdt: string;
  feeMicroUsdt: string;
  netMicroUsdt: string;
  baseFeeBps: string;
  minimumFeeMicroUsdt: string;
};
export type EscrowConfig = {
  contractAddress: string | null;
  chainId: number;
  usdtAddress: string;
  rpcUrl: string | null;
  decimals: number;
  walletConnectProjectId: string | null;
  web3AuthClientId: string | null;
  enabled: boolean;
};
export type EscrowWallet = {
  id: string;
  address: string;
  kind: 'EXTERNAL' | 'IN_APP' | 'SMART_ACCOUNT';
  chainId: number;
  isPrimary: boolean;
};
export type EscrowBalance = {
  lockedMicroUsdt: string;
  reservedMicroUsdt: string;
  availableMicroUsdt: string;
  spendableMicroUsdt: string;
  guaranteedMicroUsdt: string;
  guaranteedCoupons: string;
  guarantees: Array<{ id: string; charityName: string; remainingCoupons: string }>;
  locked: string;
  primaryWallet: EscrowWallet | null;
  enabled: boolean;
};
export type EscrowPayCode = { id: string; expiresAt: string; maxAmount: string; status?: string; wrongAttempts?: number };
export type EscrowSettlement = {
  id: string;
  status: string;
  amount: string;
  buyerId: string;
  merchantId: string;
  role: 'MERCHANT' | 'BUYER' | 'GUARANTOR';
  payerRole: 'SELF' | 'GUARANTOR';
  createdAt: string;
  confirmedAt: string | null;
  buyerBarcodeId?: string;
};
export type CharityGuarantee = {
  id: string;
  charityName: string;
  beneficiary: { displayName: string | null; barcodeId: string };
  amountCoupons: string;
  remainingCoupons: string;
  status: string;
  createdAt: string;
  closedAt: string | null;
};
export type EscrowUnload = {
  id: string;
  status: string;
  amount: string;
  walletAddress: string;
  createdAt: string;
  confirmedAt: string | null;
};
