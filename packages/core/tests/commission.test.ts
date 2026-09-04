import { describe, expect, it } from 'vitest';
import { splitCommission, splitTrainerCut } from '../src/commission.js';

describe('commission splitting', () => {
  it('splits a three-percent fee into thirds', () => {
    expect(splitCommission(1_000n, 300)).toEqual({ fee: 30n, treasury: 10n, buyerMarketer: 10n, sellerMarketer: 10n });
  });

  it('floors the fee and shares for one hundred coupons', () => {
    expect(splitCommission(100n, 300)).toEqual({ fee: 3n, treasury: 1n, buyerMarketer: 1n, sellerMarketer: 1n });
  });

  it('keeps an indivisible remainder in the treasury', () => {
    expect(splitCommission(50n, 300)).toEqual({ fee: 1n, treasury: 1n, buyerMarketer: 0n, sellerMarketer: 0n });
  });

  it('assigns any remainder after thirds to the treasury', () => {
    expect(splitCommission(1_000n, 350)).toEqual({ fee: 35n, treasury: 13n, buyerMarketer: 11n, sellerMarketer: 11n });
  });

  it('splits a marketer share with the trainer cut', () => {
    expect(splitTrainerCut(1_000n, 2_000)).toEqual({ marketer: 800n, trainer: 200n });
    expect(splitTrainerCut(7n, 2_000)).toEqual({ marketer: 6n, trainer: 1n });
    expect(splitTrainerCut(1_000n, 0)).toEqual({ marketer: 1_000n, trainer: 0n });
  });
});
