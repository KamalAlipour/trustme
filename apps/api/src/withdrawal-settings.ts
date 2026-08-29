export function requireIdentityForWithdrawal(value: string | undefined): boolean {
  return value === undefined ? true : value === 'true';
}
