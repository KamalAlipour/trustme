export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (new Set(pin).size === 1) return true;
  const ascending = pin.split('').every((digit, index, values) => index === 0 || Number(digit) === Number(values[index - 1]) + 1);
  const descending = pin.split('').every((digit, index, values) => index === 0 || Number(digit) === Number(values[index - 1]) - 1);
  return ascending || descending;
}
