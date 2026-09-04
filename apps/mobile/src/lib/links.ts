const APP_WEB_URL = 'https://app-trustcoupon.komasi.as';

export function payLink(barcodeId: string): string {
  return `${APP_WEB_URL}/pay?barcodeId=${encodeURIComponent(barcodeId)}`;
}
