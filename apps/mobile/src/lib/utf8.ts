export function encodeUtf8(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const first = input.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = input.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index]!;
    let codePoint: number;
    let width: number;
    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf && index + 1 < bytes.length && (bytes[index + 1]! & 0xc0) === 0x80) {
      codePoint = ((first & 0x1f) << 6) | (bytes[index + 1]! & 0x3f);
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef && index + 2 < bytes.length && (bytes[index + 1]! & 0xc0) === 0x80 && (bytes[index + 2]! & 0xc0) === 0x80) {
      const second = bytes[index + 1]!;
      const third = bytes[index + 2]!;
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = codePoint >= 0x800 && !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? 3 : 0;
    } else if (first >= 0xf0 && first <= 0xf4 && index + 3 < bytes.length && (bytes[index + 1]! & 0xc0) === 0x80 && (bytes[index + 2]! & 0xc0) === 0x80 && (bytes[index + 3]! & 0xc0) === 0x80) {
      const second = bytes[index + 1]!;
      const third = bytes[index + 2]!;
      const fourth = bytes[index + 3]!;
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = codePoint >= 0x10000 && codePoint <= 0x10ffff ? 4 : 0;
    } else {
      codePoint = 0xfffd;
      width = 0;
    }
    result += String.fromCodePoint(codePoint);
    index += width || 1;
  }
  return result;
}
