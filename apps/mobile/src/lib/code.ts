import { getRandomBytesAsync } from 'expo-crypto';

export type ByteSource = (length: number) => Promise<Uint8Array>;

const secureByteSource: ByteSource = (length) => getRandomBytesAsync(length);

export async function randomFourDigitCode(byteSource: ByteSource = secureByteSource): Promise<string> {
  let code = '';
  while (code.length < 4) {
    const bytes = await byteSource(32);
    if (bytes.length === 0) throw new Error('secure randomness unavailable');
    for (const byte of bytes) {
      if (byte >= 250) continue;
      code += String(byte % 10);
      if (code.length === 4) return code;
    }
  }
  throw new Error('secure randomness unavailable');
}
