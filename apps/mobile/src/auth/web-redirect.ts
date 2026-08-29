export function readIdTokenFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const fragmentToken = new URLSearchParams(parsed.hash.replace(/^#/, '')).get('id_token');
    if (fragmentToken) return fragmentToken;
    const queryToken = parsed.searchParams.get('id_token');
    return queryToken || null;
  } catch {
    return null;
  }
}
