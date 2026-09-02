export function deviceLabelFrom(platform: string, version: string | number | null, userAgent: string | null): string {
  if (platform === 'web') {
    if (userAgent === null || userAgent.length === 0) return 'Browser';
    const browser = userAgent.includes('SamsungBrowser')
      ? 'Samsung Internet'
      : userAgent.includes('Edg')
        ? 'Edge'
        : userAgent.includes('OPR') || userAgent.includes('Opera')
          ? 'Opera'
          : userAgent.includes('Firefox')
            ? 'Firefox'
            : userAgent.includes('Chrome') || userAgent.includes('CriOS')
              ? 'Chrome'
              : userAgent.includes('Safari')
                ? 'Safari'
                : 'Browser';
    const os = userAgent.includes('Android')
      ? 'Android'
      : userAgent.includes('iPhone')
        ? 'iPhone'
        : userAgent.includes('iPad')
          ? 'iPad'
          : userAgent.includes('Windows')
            ? 'Windows'
            : userAgent.includes('Mac OS')
              ? 'Mac'
              : userAgent.includes('Linux')
                ? 'Linux'
                : null;
    return os === null ? browser : `${browser} on ${os}`;
  }
  const name = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : platform || 'Unknown';
  const normalizedVersion = version === null ? '' : String(version).trim();
  return `${name}${normalizedVersion.length > 0 ? ` ${normalizedVersion}` : ''} app`;
}
