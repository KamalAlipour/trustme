import express from 'express';
import { ApiKeyScope, PrismaClient } from '@trustme/db';
import { networkAverageRateBps } from '@trustme/core';
import { publicReservesPayload } from './public-router.js';
import { requireApiKey } from './partner-auth.js';

export function createPartnerRouter(prisma: PrismaClient): express.Router {
  const router = express.Router();
  router.get('/market-average', requireApiKey(prisma, ApiKeyScope.READ_MARKET_AVERAGE), async (_request, response, next) => {
    try {
      const networkAverageBps = await prisma.$transaction((tx) => networkAverageRateBps(tx));
      response.json({ networkAverageBps });
    } catch (error) {
      next(error);
    }
  });
  router.get('/reserves', requireApiKey(prisma, ApiKeyScope.READ_RESERVES), async (_request, response, next) => {
    try {
      response.json(await publicReservesPayload(prisma));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
