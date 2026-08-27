UPDATE "EscrowHold" h
SET "releaseTransactionId" = t."id"
FROM "Transaction" t
WHERE h."releaseTransactionId" IS NULL
  AND t."externalRef" = 'escrow:' || h."id"::text || ':release'
  AND NOT EXISTS (
    SELECT 1
    FROM "EscrowHold" existing
    WHERE existing."releaseTransactionId" = t."id"
      AND existing."id" <> h."id"
  );
