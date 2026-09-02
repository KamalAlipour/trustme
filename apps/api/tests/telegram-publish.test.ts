import { describe, expect, it } from 'vitest';

// @ts-expect-error The plain ESM publisher intentionally has no TypeScript build output.
import { planActions } from '../../../ops/telegram/publish.mjs';

type PlanAction = {
  slug: string;
  action: 'edit' | 'send';
  messageId: number | undefined;
};

type TelegramState = {
  chatId: string;
  messages: Record<string, number>;
};

const plan = planActions as (files: string[], state: TelegramState) => PlanAction[];

const state: TelegramState = {
  chatId: '-1003861509835',
  messages: {
    '01-intro': 7,
    '02-barcode': 8,
    '03-identity': 9,
  },
};

describe('Telegram guide publishing plan', () => {
  it('edits every known message', () => {
    const actions = plan([
      '01-intro.md',
      '02-barcode.md',
      '03-identity.md',
    ], state);
    expect(actions).toEqual([
      { slug: '01-intro', action: 'edit', messageId: 7 },
      { slug: '02-barcode', action: 'edit', messageId: 8 },
      { slug: '03-identity', action: 'edit', messageId: 9 },
    ]);
  });

  it('sends a message whose slug has no recorded id', () => {
    const actions = plan(['01-intro.md', '04-tether.md'], state);
    expect(actions[1]).toEqual({ slug: '04-tether', action: 'send', messageId: undefined });
  });

  it('does not plan a recorded slug whose file disappeared', () => {
    const actions = plan(['01-intro.md', '03-identity.md'], state);
    expect(actions.map(({ slug }) => slug)).toEqual(['01-intro', '03-identity']);
  });
});
