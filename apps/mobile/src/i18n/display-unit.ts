export type DisplayUnit = {
  en: {
    singular: string;
    plural: string;
  };
  fa: string;
};

export const DEFAULT_DISPLAY_UNIT: DisplayUnit = {
  en: {
    singular: 'US cent',
    plural: 'US cents',
  },
  fa: 'سنت دلار آمریکا',
};
