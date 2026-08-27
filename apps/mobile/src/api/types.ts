export type Member = {
  id: string;
  displayName: string | null;
  barcodeId: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  kycStatus: string;
  activeGuaranteeCount: number;
  isRestricted: boolean;
};

export type Tokens = {
  accessToken: string;
  expiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

export type AuthResponse = { tokens: Tokens; member: Member };
export type Balance = { barcodeId: string; coupons: string; dustMicroUsdt: string; depositAddress: string | null };
export type Transaction = {
  id: string;
  direction: 'in' | 'out';
  amountCoupons: string;
  counterparty: { displayName?: string | null; barcodeId?: string; systemAccountType?: string };
  transaction: { type: string; status: string; createdAt: string };
};
export type TransactionsPage = { items: Transaction[]; nextCursor: string | null };
export type Contact = { id: string; alias: string; barcodeId: string; displayName: string | null; lastActivityAt: string | null; createdAt: string };
export type LoanInstallment = { id: string; sequence: number; dueAt: string; amountCoupons: string; paidCoupons: string; paidAt: string | null };
export type Guarantee = { id: string; loanId: string; guarantorId: string; amountCoupons: string; status: string; wrongAttempts: number; lockedAt: string | null; activatedAt: string | null; resolvedAt: string | null; guarantor?: { displayName: string | null; barcodeId: string } };
export type Loan = { id: string; borrowerId: string; lenderId: string | null; principalCoupons: string; outstandingCoupons: string; status: string; createdAt: string; fundedAt: string | null; settledAt: string | null; installments: LoanInstallment[]; guarantees: Guarantee[] };
export type WithdrawalAvailability = {
  lockedGuaranteeCoupons: string;
  outstandingDebtCoupons: string;
  totalCollateralCoupons: string;
  availableToWithdrawCoupons: string;
  blockers: string[];
};
export type Withdrawal = { id: string; status: string; couponsGross: string; grossUsdt: string; feeUsdt: string; netUsdt: string; chainTxHash: string | null; eligibleAt: string };
