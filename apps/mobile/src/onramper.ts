export function onramperWidgetUrl(input: {
  apiKey: string;
  depositAddress: string;
  amountUsdt?: string;
  language: 'en' | 'fa';
  userId: string;
}): string {
  const params = new URLSearchParams({
    apiKey: input.apiKey,
    mode: 'buy',
    onlyCryptos: 'usdt_polygon',
    defaultCrypto: 'usdt_polygon',
    wallets: `usdt_polygon:${input.depositAddress}`,
    isAddressEditable: 'false',
    defaultFiat: 'eur',
    partnerContext: input.userId,
    language: input.language,
  });
  if (input.amountUsdt !== undefined) params.set('defaultAmount', input.amountUsdt);
  return `https://buy.onramper.com/?${params.toString()}`;
}
