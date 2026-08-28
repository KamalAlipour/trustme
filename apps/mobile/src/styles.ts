import { StyleSheet } from 'react-native';

export const colors = {
  ink: '#16202A',
  muted: '#65727E',
  primary: '#176B87',
  background: '#F5F8FA',
  card: '#FFFFFF',
  border: '#D8E1E7',
  danger: '#B3261E',
  success: '#216E4E',
} as const;

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: 20 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: colors.background },
  scroll: { padding: 20, gap: 16 },
  title: { color: colors.ink, fontSize: 26, fontWeight: '700', textAlign: 'right' },
  heading: { color: colors.ink, fontSize: 20, fontWeight: '700', textAlign: 'right' },
  text: { color: colors.ink, fontSize: 16, textAlign: 'right', lineHeight: 25 },
  muted: { color: colors.muted, fontSize: 14, textAlign: 'right', lineHeight: 22 },
  demoLabel: { color: '#8A949C', fontSize: 11, textAlign: 'right', lineHeight: 16 },
  card: { backgroundColor: colors.card, borderRadius: 18, padding: 18, gap: 10, borderWidth: 1, borderColor: colors.border },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 13, fontSize: 16, color: colors.ink, textAlign: 'right' },
  button: { backgroundColor: colors.primary, borderRadius: 12, padding: 14, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  secondaryButton: { borderColor: colors.primary, borderWidth: 1, borderRadius: 12, padding: 13, alignItems: 'center' },
  secondaryButtonText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
  danger: { color: colors.danger, fontSize: 14, textAlign: 'right' },
  notice: { color: colors.success, fontSize: 14, textAlign: 'right' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  pill: { borderRadius: 99, backgroundColor: '#E5F2F5', paddingHorizontal: 10, paddingVertical: 5 },
  divider: { height: 1, backgroundColor: colors.border },
});
