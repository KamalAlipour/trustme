import type { PrismaClient } from '@trustme/db';

export const DEFAULT_DISPLAY_UNIT = {
  en: {
    singular: 'US cent',
    plural: 'US cents',
  },
  fa: 'سنت دلار آمریکا',
} as const;

export type DisplayUnit = {
  en: {
    singular: string;
    plural: string;
  };
  fa: string;
};

const DISPLAY_UNIT_KEYS = [
  'DISPLAY_UNIT_EN_SINGULAR',
  'DISPLAY_UNIT_EN_PLURAL',
  'DISPLAY_UNIT_FA',
] as const;

export async function readDisplayUnit(prisma: PrismaClient): Promise<DisplayUnit> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: [...DISPLAY_UNIT_KEYS] } },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    en: {
      singular: values.get('DISPLAY_UNIT_EN_SINGULAR') || DEFAULT_DISPLAY_UNIT.en.singular,
      plural: values.get('DISPLAY_UNIT_EN_PLURAL') || DEFAULT_DISPLAY_UNIT.en.plural,
    },
    fa: values.get('DISPLAY_UNIT_FA') || DEFAULT_DISPLAY_UNIT.fa,
  };
}
