export type WithdrawalActionState = {
  status: string;
  chainTxHash: string | null;
};

export function canRejectWithdrawal(row: WithdrawalActionState): boolean {
  return row.chainTxHash === null && ['PENDING_APPROVAL', 'APPROVED', 'FAILED'].includes(row.status);
}

export function canApproveWithdrawal(row: Pick<WithdrawalActionState, 'status'>): boolean {
  return row.status === 'PENDING_APPROVAL';
}
