import 'react-native-get-random-values';
import { decodeUtf8, encodeUtf8 } from './utf8';

class WalletTextEncoder {
  readonly encoding = 'utf-8';

  encode(input = ''): Uint8Array {
    return encodeUtf8(input);
  }
}

class WalletTextDecoder {
  readonly encoding = 'utf-8';
  readonly fatal = false;
  readonly ignoreBOM = false;

  decode(input?: Uint8Array): string {
    return input === undefined ? '' : decodeUtf8(input);
  }
}

export const installWalletPolyfills = (): void => {
  if (globalThis.TextEncoder === undefined) {
    globalThis.TextEncoder = WalletTextEncoder as typeof TextEncoder;
  }
  if (globalThis.TextDecoder === undefined) {
    globalThis.TextDecoder = WalletTextDecoder as typeof TextDecoder;
  }
};
