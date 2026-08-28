# TrustMe — architecture and money model

TrustMe is the financial module of the "social coupon" platform: USDT (Polygon
PoS) comes in, becomes internal coupons, circulates off-chain between members,
and can be redeemed back to USDT minus a dynamic fee.

It is deliberately **isolated** from every other product on the same hosts: own
repository, own PostgreSQL database and role, own Redis instance, own OS user,
own ports and own nginx vhost. Nothing is shared but the metal.

## 1. Repository layout

```
packages/db      Prisma schema, migrations, generated client
packages/core    domain logic: ledger, coupon math, fees, escrow, withdrawals
apps/api         Express + Zod + OpenAPI (public/member API)
apps/worker      BullMQ workers: chain ingest, withdrawal dispatch
apps/admin       Next.js App Router + Tailwind + shadcn/ui (admin dashboard)
```

npm workspaces, TypeScript everywhere, `strict: true`, no `any`.

## 2. Units — integers only, never floats

| Asset | Stored as | Unit |
|---|---|---|
| `USDT` | `BigInt` | micro-USDT, 1 USDT = 1_000_000 (matches the 6-decimals USDT contract on Polygon) |
| `COUPON` | `BigInt` | one coupon, 1 USDT = 100 coupons |

So 1 coupon = 10_000 micro-USDT. Conversions live in one place
(`packages/core/src/money.ts`) and are exact integer arithmetic:

```
couponsFromMicroUsdt(m) = m / 10_000            // floor
microUsdtFromCoupons(c) = c * 10_000            // exact
```

A deposit that is not a whole multiple of 10_000 micro-USDT leaves a remainder
("dust") in the platform vault; the dust is never lost, it simply is not
convertible into a coupon. `roundingDustMicroUsdt` is recorded on the deposit
transaction so the books can explain the difference.

Dust is **carried per member** rather than dropped: `User.dustMicroUsdt` holds
the remainder, and every deposit mints
`floor((dustCarry + amount) / 10_000)` coupons and writes back the new
remainder, inside the same atomic posting. A deposit smaller than one coupon is
therefore accepted, not rejected: it posts the USDT leg, omits the coupon leg
and grows the carry, and the next deposit that pushes the carry past a whole
coupon mints it. Ledger entries are always strictly positive; a zero-value
coupon entry is never written.

The carry is a claim on the vault that has not become a coupon yet, so the
solvency invariant below counts it alongside the coupon liability.

## 3. Double-entry ledger

Every balance change is an entry in `LedgerEntry` with a `fromAccount`, a
`toAccount`, an `amount` and an `asset`. There are no one-sided postings.

Account types:

| Type | Asset | Sign | Meaning |
|---|---|---|---|
| `USER_COUPON` | COUPON | >= 0 | a member's spendable coupons |
| `ESCROW` | COUPON | >= 0 | coupons locked by a one-time code |
| `SYSTEM_COUPON_ISSUANCE` | COUPON | <= 0 | mint/burn counter-account; its negative balance is the total coupons in circulation |
| `SYSTEM_VAULT_USDT` | USDT | >= 0 | USDT actually held by the platform |
| `SYSTEM_WITHDRAWAL_PENDING` | USDT | >= 0 | USDT committed to a payout that has not confirmed on-chain |
| `SYSTEM_FEE_COLLECTION` | USDT | >= 0 | fees earned |
| `EXTERNAL_ONCHAIN` | USDT | any | the world outside; deposits come from it, payouts go to it |

**Invariants** (enforced in code and asserted by tests):

1. For every `Transaction` and every asset, the sum of entry amounts leaving
   equals the sum arriving — trivially true given from/to entries, so the real
   test is that a transaction never posts only one leg.
2. `sum(balance) == 0` per asset across all accounts, at all times.
3. `USER_COUPON`, `ESCROW`, `SYSTEM_*` (except `SYSTEM_COUPON_ISSUANCE`) and
   `EXTERNAL_ONCHAIN` balances respect the sign column above — a DB `CHECK`
   plus an application guard.
4. Solvency is measured from custody and obligations. Custody is
   `SYSTEM_VAULT_USDT.balance + SYSTEM_WITHDRAWAL_PENDING.balance +
   SYSTEM_FEE_COLLECTION.balance`; obligations are
   `-SYSTEM_COUPON_ISSUANCE.balance * 10_000 + sum(User.dustMicroUsdt) +
   SYSTEM_WITHDRAWAL_PENDING.balance`. The surplus is custody minus obligations,
   so an in-flight withdrawal is counted as both held custody and a payout
   obligation. The admin dashboard surfaces the component breakdown and marks
   the system solvent only when the surplus is non-negative.

**Concurrency.** A posting runs inside a single `prisma.$transaction` at
`Serializable`, and locks the touched accounts with `SELECT ... FOR UPDATE`
**ordered by account id ascending** — the ordering is what keeps two opposite
transfers from deadlocking. Balance updates are relative
(`balance = balance - $amount`), never read-modify-write from application memory.

**Idempotency.** Every posting carries an `externalRef` unique key
(`deposit:<txHash>:<logIndex>`, `withdrawal:<id>:burn`, …). A duplicate posting
attempt is a no-op that returns the existing transaction, so any worker retry,
reorg re-scan or double-clicked admin button is harmless.

## 4. Deposit and minting

1. Each member gets a unique deposit address derived from an **xpub held in the
   environment** — `m/44'/60'/0'/0/<derivationIndex>` via
   `ethers.HDNodeWallet.fromExtendedKey(XPUB).deriveChild(index)`. The private
   side of that key never touches the servers.
2. `derivationIndex` is allocated by a DB sequence, so two concurrent
   registrations can never share an address.
3. The chain ingest worker walks `Transfer(address,address,uint256)` logs of the
   USDT contract from a persisted cursor, in bounded block ranges, and only up
   to `head - CONFIRMATIONS` (12). Logs whose `to` is not a known deposit
   address are dropped. A tick can process several confirmed ranges, bounded by
   `INGEST_CHUNKS_PER_TICK`, so a temporary outage can be caught up without
   changing the RPC request-size limit.
4. Each accepted log posts, once (see idempotency):
   - `USDT`: `EXTERNAL_ONCHAIN → SYSTEM_VAULT_USDT`, the full amount;
   - `COUPON`: `SYSTEM_COUPON_ISSUANCE → USER_COUPON`, `amount / 10_000` floored.

Reorgs shallower than 12 blocks cannot affect us; the cursor also stores the
block hash so a deeper reorg is detected and the scan rewinds instead of
silently skipping blocks.

After an accepted deposit is posted, the worker marks its deposit address for
the sweep queue. The sweep loop orders pending addresses by that marker and
reads the current on-chain USDT balance. Balances below
`SWEEP_MIN_MICRO_USDT` remain as dust. Otherwise the worker derives the
per-address signer from the mnemonic-backed account node, verifies the derived
address against the database, estimates a safe ERC-20 transfer, and sweeps the
full current balance into the hot wallet. If the address needs native gas, a
gas-funding transaction is recorded in `DepositSweep` and signed by the hot
wallet through the serialized withdrawal dispatch queue; the sweep resumes
after that transaction is mined. Sweep records are an audit trail only and
create no ledger entries. A failed receipt keeps the pending marker for retry.
The sweep cadence and batch are controlled by `SWEEP_SCAN_INTERVAL_MS` and
`SWEEP_BATCH_SIZE`; `SWEEP_MAX_GAS_TOP_UP_WEI` caps native-gas funding for one
deposit address. `DEPOSIT_WALLET_MNEMONIC_PATH` points to the signing mnemonic
file and `DEPOSIT_XPUB` identifies the matching public account node.

## 5. Internal circulation

- **Transfer**: `USER_COUPON → USER_COUPON`, instant, no fee, no chain.
- **Escrow**: creating a hold moves coupons `USER_COUPON → ESCROW` and stores a
  **hash** of the 4-digit code (never the code) plus an expiry. Releasing moves
  `ESCROW → USER_COUPON` of the recipient; cancelling or expiring moves them
  back to the sender. A 4-digit code is small, so a hold is locked after 5 wrong
  attempts and codes are scoped to a single hold, not to a user.

## 6. Withdrawal, fee and burn

1. Request: `couponsGross` + `destinationAddress` (EIP-55 checksum validated).
2. `grossMicroUsdt = couponsGross * 10_000`,
   `fee = grossMicroUsdt * WITHDRAWAL_BASE_FEE_BPS / 10_000` (floored),
   `net = grossMicroUsdt - fee`. `net` must be `>= MIN_WITHDRAWAL_USDT`.
3. One atomic posting burns and reserves:
   - `COUPON`: `USER_COUPON → SYSTEM_COUPON_ISSUANCE` (`couponsGross`)
   - `USDT`: `SYSTEM_VAULT_USDT → SYSTEM_FEE_COLLECTION` (`fee`)
   - `USDT`: `SYSTEM_VAULT_USDT → SYSTEM_WITHDRAWAL_PENDING` (`net`)
4. `net <= AUTO_APPROVAL_LIMIT_USDT` → `APPROVED` immediately and enqueued;
   otherwise `PENDING_APPROVAL` until an admin with the `APPROVER` role acts.
5. Dispatch worker (BullMQ job id = withdrawal id, so one job per withdrawal):
   signs with the hot-wallet key **read from the environment inside the worker
   process only**, persists the tx hash *before* broadcasting, then broadcasts.
   On restart an in-flight withdrawal is resumed by looking up its hash instead
   of signing a second transaction.
6. Confirmed: `SYSTEM_WITHDRAWAL_PENDING → EXTERNAL_ONCHAIN` (`net`),
   status `COMPLETED`. Rejected or permanently failed: the reservation and the
   burn are reversed (`SYSTEM_WITHDRAWAL_PENDING → SYSTEM_VAULT_USDT`,
   `SYSTEM_FEE_COLLECTION → SYSTEM_VAULT_USDT`,
   `SYSTEM_COUPON_ISSUANCE → USER_COUPON`) and the member has their coupons back.

All hot-wallet signing work, including native-gas top-ups for deposit sweeps,
must use `DISPATCH_QUEUE`, whose concurrency is one. Deposit-key ERC-20 sweep
transactions use independent nonces and run on the separate sweep queue.

## 7. Admin dashboard

Next.js App Router, protected by JWT with roles `VIEWER`, `APPROVER`, `ADMIN`;
passwords are argon2 hashes, and approval actions are written to an append-only
`AdminAuditLog`.

- **Overview**: vault USDT, coupons in circulation, solvency ratio (invariant 4),
  fees collected, 24 h transaction count, RPC head/lag, hot-wallet balance.
- **Settings**: withdrawal base fee (bps), minimum withdrawal, auto-approval
  threshold — every change audited with old and new value.
- **Withdrawal queue**: filter by status, approve-and-send / reject-and-refund,
  member barcode, consumption history, computed fee, destination, explorer link.
- **Ledger logs**: every transaction and entry, searchable by barcode or id.

## 8. Deployment (isolated, S1 primary + S2 replica)

| | Server 1 — primary | Server 2 — standby |
|---|---|---|
| OS user | `trustme` (no shared home with anything else) | same |
| Postgres | dedicated cluster `trustme`, database `trustme`, role `trustme` | dedicated streaming replica over the TrustMe-only tunnel |
| Redis | own instance, own port, `requirepass`, bound to localhost | started only at failover |
| Ports | PG `5434`, Redis `6380`, API `3121`, admin `3122` (loopback only) | same, plus replication tunnel `5435` (loopback only) |
| Web | own nginx vhost / own hostname | vhost installed at failover |
| Secrets | `/etc/trustme/trustme.env`, owned by `root:trustme`, mode 0640 | provisioned separately, never committed |

The chain ingest, dispatch, and deposit-sweep workers run **only on the primary**: a standby
that starts signing payouts is the one failure mode this system cannot tolerate,
so the API and worker refuse to start when the failover marker file is present.
The default marker is `/etc/trustme/FAILED_OVER`, overridable through
`FAILOVER_MARKER_PATH`. The marker means that this machine is not the active
TrustMe node: it is present on Server 2 during normal operation and is written
onto Server 1 by the promote script when TrustMe moves to Server 2. This is a
safety interlock because two live workers sharing one hot wallet could collide
on nonces or double-pay, not a convenience switch.

The authoritative TrustMe port map is also kept in `ops/ports.sh` and enforced
by `ops/preflight.sh`:

| Service | Port |
|---|---:|
| TrustMe PostgreSQL | `5434` |
| TrustMe replication tunnel on Server 2 | `5435` |
| TrustMe Redis | `6380` |
| TrustMe API | `3121` |
| TrustMe admin UI | `3122` |

PostgreSQL, Redis, API, and admin bind to `127.0.0.1`; nginx is the only public
listener.
