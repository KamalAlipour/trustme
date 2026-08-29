export function isPlausiblePhoneNumber(value: string): boolean {
  const phone = value.trim();
  return /^(?:\+?[1-9]\d{7,14}|0\d{9,14})$/.test(phone);
}
