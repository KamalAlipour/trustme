export type HotWalletBalanceProvider = {
  getNativeBalance(address: string): Promise<bigint>;
  getTokenBalance(tokenAddress: string, ownerAddress: string): Promise<bigint>;
};

export async function getHotWalletBalances(
  provider: HotWalletBalanceProvider,
  usdtContractAddress: string,
  hotWalletAddress: string,
): Promise<{ usdtBalanceMicroUsdt: bigint; nativeBalanceWei: bigint }> {
  const [usdtBalanceMicroUsdt, nativeBalanceWei] = await Promise.all([
    provider.getTokenBalance(usdtContractAddress, hotWalletAddress),
    provider.getNativeBalance(hotWalletAddress),
  ]);
  return { usdtBalanceMicroUsdt, nativeBalanceWei };
}
