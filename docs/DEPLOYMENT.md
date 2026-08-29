# TrustMe deployment runbook

## Scope and topology

TrustMe is deployed as an isolated service on two hosts:

* Server 1 (`komasi-ai`, `167.233.226.100`) is the normal primary.
* Server 2 (`komasi-vps`, `62.238.35.7`) is a warm standby.

Each host has its own `trustme` system user, PostgreSQL cluster, PostgreSQL
role/database, Redis instance, systemd units, application ports, and nginx
vhost. TrustMe does not use FairFare's users, database cluster, replication
slot, tunnel, credentials, ports, marker, or nginx configuration.

The authoritative port map is in `ops/ports.sh`:

| Service | Port |
|---|---:|
| TrustMe PostgreSQL | `5434` |
| TrustMe replication tunnel on Server 2 | `5435` |
| TrustMe Redis | `6380` |
| TrustMe API | `3121` |
| TrustMe admin UI | `3122` |
| Temporary failback tunnel | `5436` |

All TrustMe application, Redis, and PostgreSQL listeners bind to `127.0.0.1`.
Only nginx is public-facing. `ops/preflight.sh` checks every port before
installation rather than trusting these values blindly.

## Installation order

Run the scripts locally on the intended host as root. They have not been run
against the production servers.

1. Run `ops/preflight.sh`.
2. Run `ops/s1-install.sh` on Server 1.
3. Fill `/etc/trustme/trustme.env` from `ops/env/trustme.env.example` using the
   secret-management process. Keep it mode `0640`, owned by `root:trustme`.
   Configure `DEPOSIT_XPUB`, `DEPOSIT_DERIVATION_PATH`, and
   `DEPOSIT_WALLET_MNEMONIC_PATH` together to
   enable automatic USDT sweeping. The mnemonic file must be owned by
   `root:trustme` with mode `0640`; it is read only by the worker. If
   `DEPOSIT_XPUB` is absent or the file is unreadable, sweeping stays disabled
   and the worker still starts. The mnemonic file may contain blank lines and
   whole-line `#` comments; they are ignored before parsing. The worker
   derives the account node at `DEPOSIT_DERIVATION_PATH` and validates that
   its xpub matches `DEPOSIT_XPUB` before starting. This path must be exactly
   the path used when the configured xpub was generated; a mismatch aborts
   worker startup by design.
   `SWEEP_MIN_MICRO_USDT` sets the minimum sweep balance,
   `SWEEP_MAX_GAS_TOP_UP_WEI` caps native-gas funding,
   `SWEEP_SCAN_INTERVAL_MS` controls the scan cadence, and
   `SWEEP_BATCH_SIZE` limits addresses considered per scan.
   `SWEEP_FAILURE_BACKOFF_MS` delays replacement sweeps after a permanent
   failure, while `SWEEP_MAX_ATTEMPTS` disarms an address after that many
   consecutive failed sweep records. Failed records remain available for
   admin attention. To re-arm an address, an authorized operator must set its
   `DepositAddress.sweepPendingAt` marker again (for example, with an
   `UPDATE "DepositAddress" SET "sweepPendingAt" = NOW() WHERE "id" = ...`
   maintenance statement).
4. Deploy a reviewed ref with `ops/deploy.sh --ref <git-ref>`.
5. Run `ops/s2-standby.sh` on Server 2.

The install scripts are idempotent for TrustMe-owned resources. Their
preflight mode still fails on unrelated listeners, clusters, roles, databases,
or files owned by the `trustme` user. PostgreSQL, Redis, nginx, and systemd
must already be available; package provisioning is deliberately not performed
by these scripts.

PostgreSQL replication credentials use the TrustMe-owned
`/etc/trustme/pgpass` file (configurable with `TRUSTME_PGPASS_FILE`), owned by
the `postgres` user with mode `0600`. The scripts never modify the shared
`/var/lib/postgresql/.pgpass` file.

The API and worker systemd templates contain a
`__TRUSTME_PG_UNIT__` placeholder. Each install substitutes it with the
configured `postgresql@<version>-trustme.service` unit so application startup
is ordered after the dedicated cluster, not FairFare's PostgreSQL unit.

## Marker interlock

`FAILOVER_MARKER_PATH` defaults to `/etc/trustme/FAILED_OVER`. Its meaning is
“this machine is not the active TrustMe node.” Server 2 has the marker during
normal standby operation. The API and worker refuse to start while it exists,
and the systemd units have an additional `ExecStartPre` check. The admin unit
is disabled on a standby as well.

Promotion writes the marker onto Server 1 before fencing attempts, stops the
replication tunnel, promotes Server 2's PostgreSQL cluster, and removes the
local marker only after promotion succeeds. This is a safety interlock:
**two live workers sharing one hot wallet would collide on nonces / double-pay**.
It is not a convenience feature and must not be bypassed while another node
could still sign.

## Deployment and rollback

`ops/deploy.sh` accepts `--ref`, fetches that ref into a TrustMe-only mirror,
creates a timestamped release under `/opt/trustme/releases`, runs `npm ci` and
the workspace build, and runs Prisma migrations unless `--no-migrate` is
specified. It swaps `/opt/trustme/current` atomically.

The safe restart order is worker stop, migration, API/admin restart, then
worker start. On a standby the marker prevents the worker from starting.
`ops/deploy.sh --rollback` atomically points `current` at the previous release
and repeats the safe service restart sequence.

## First-run bootstrap

Migrations create no rows, so a fresh database needs the system ledger accounts,
the default settings, and one admin account before the dashboard can be used.
Run both from the release directory as the `trustme` user, with the environment
file loaded:

```text
npm run prisma:seed
ADMIN_USERNAME=<name> ADMIN_ROLE=ADMIN npm run admin:create   # password on stdin
```

`admin:create` upserts by username, requires at least 12 characters, hashes with
bcrypt cost 12, and prints only the username and role. Prefer piping the
password from a file or a password manager over `ADMIN_PASSWORD` in the
environment, so it never reaches the shell history or the process list.

## Promotion

On Server 2, after confirming that Server 1 is unavailable or has been fenced:

```text
/opt/trustme/ops/promote.sh
```

The script best-effort connects to Server 1 over the configured SSH key to
stop TrustMe units and write `/etc/trustme/FAILED_OVER`. SSH failure is logged
and does not pretend that fencing succeeded; an operator must account for the
split-brain risk. Locally it stops the TrustMe replication tunnel, calls
`pg_promote`, waits for recovery to end, refreshes database collation metadata,
reindexes, removes the local marker, and starts Redis and the application
units. The collation refresh/reindex is needed because the hosts can have
different glibc versions and text indexes must be rebuilt before independent
service.

The script prints the manual actions still required: install/reload the local
TrustMe nginx vhost, obtain certificates, and move the TrustMe DNS records to
Server 2. It installs and validates the local vhost during promotion but does
not modify Cloudflare or run certbot.

## Failback

Failback is never automatic. On the active Server 2, after checking that
Server 1 is reachable and ready:

```text
/opt/trustme/ops/failback.sh --force
```

The explicit `--force` is required. The script first marks Server 2 inactive
and stops its worker, API, admin, Redis, and tunnel. It creates a new
TrustMe-only physical replication slot and uses a temporary reverse SSH tunnel
to re-seed Server 1 from the current primary. Server 1 is then promoted,
unmarked, and its TrustMe services are enabled. Finally, the script invokes
the standby setup to re-seed Server 2 from the new primary and restore the
marker. DNS and nginx are operator actions printed by the script.

Do not run failback while Server 2 can still receive writes or while the
replication/tunnel state is uncertain. The script logs to
`/var/log/trustme-failback.log` and is designed to be safe to re-run only after
the operator has reconciled the current role.

## Streaming replication and Redis

Server 2's PostgreSQL cluster is a physical streaming replica of Server 1.
The replication connection reaches Server 1's loopback-only PostgreSQL through
the TrustMe systemd tunnel on Server 2's local port `5435`. The replication
role, password, and slot are TrustMe-specific. FairFare's local `5433` tunnel
and replication slot are never used. Failback uses the separate,
configurable `TRUSTME_FAILBACK_TUNNEL_PORT` (default `5436`).

Redis is an independent append-only instance on port `6380`, with its own
configuration and data directory. Its systemd unit is enabled on the primary
and disabled on the standby. Redis is not replicated by these scripts; the
standby starts its empty local instance only after promotion.

## nginx, TLS, and DNS

`ops/nginx/trustme.conf` has separate API and admin server blocks with
templated hostnames. The install script substitutes
`__TRUSTME_API_HOST__` and `__TRUSTME_ADMIN_HOST__` from the environment file.
It proxies to `127.0.0.1:3121` and `127.0.0.1:3122`, includes security headers,
and rate-limits login requests.
The admin CSP explicitly allows Next.js' inline bootstrap and hydration scripts
and inline styles; tightening it with nonces requires verification against a
running instance.

After DNS points to the active host, an operator can obtain certificates with
the documented command:

```text
certbot --nginx -d <TRUSTME_API_HOST> -d <TRUSTME_ADMIN_HOST>
```

FairFare failover stops nginx on Server 1, which also takes TrustMe's vhost
offline. TrustMe therefore has its own promote path and must be included in
the operator's failover checklist.

## Required operator input and caveats

## Member security configuration

Set `REQUIRE_EMAIL_VERIFICATION=true` to require email verification before
member security setup completes, and configure a real email delivery channel
(`log` is suitable only for non-production testing). Startup refuses the
conflicting pair `REQUIRE_EMAIL_VERIFICATION=true` and
`EMAIL_DELIVERY=none`, because registrations could not complete setup.
The default is `REQUIRE_EMAIL_VERIFICATION=false`, so registration does not
depend on SMTP or email-code delivery unless an operator enables the setting.
`PIN_RESET_QUARANTINE_HOURS` controls the outgoing-value quarantine after a
PIN reset and defaults to 72 hours.

Biometric enrolment records local device biometrics used to unlock a
device-held key; it is not server-side biometric attestation. Browser clients
and native devices without usable enrolled biometrics can complete setup with
the PIN acknowledgement path and are shown a notice that native biometrics
require the mobile app or can be enabled later. The API reports this state as
`biometricPending` without claiming that biometrics were enrolled.

The security-setup migration backfills existing PIN-protected accounts with
acknowledgement and setup-completed timestamps (not a biometric enrolment they
never performed) so the feature does not lock out
members who were created before its release. This is a deliberate
grandfathering carve-out; a PIN reset clears the setup state and requires the
member to establish it again.

After a PIN reset, the old devices are revoked, biometric enrolment is cleared,
and withdrawals, transfers, escrow, and other outgoing-value operations are
blocked until quarantine expiry. An administrator sees the quarantine
timestamp and `pin_reset_quarantine` availability blocker in the member
record/withdrawal view. After the quarantine, the member signs in and
re-establishes the required setup. If a sweep or other operational marker is
being managed separately, operators re-arm it by setting its pending marker;
the security quarantine itself expires automatically according to the configured
duration.

Shahkar identity verification is configured with `SHAHKAR_API_TOKEN` and
`IDENTITY_HASH_PEPPER` in the API environment. The check is available only when
both values are present; `SHAHKAR_BASE_URL` may override the default Shahkar
endpoint. The pepper must be at least 32 characters and these values must be
provided through the deployment secret-management process, not committed here.

The user must still provide and authorize:

## Demo barcode data

Demo data is isolated from real circulation and solvency metrics. The CLI uses
the reserved, non-routable phone range `+99000` followed by an eight-digit
decimal index (for example, `+9900000000001`), and creates users without PINs.
It must never be run against the production database without a separate,
explicit operator decision.

Every mutating command requires the explicit safety gate:

```text
ALLOW_DEMO_DATA=true npm run demo-barcodes --workspace @trustme/api -- generate --count 5000
ALLOW_DEMO_DATA=true npm run demo-barcodes --workspace @trustme/api -- purge --count 500
ALLOW_DEMO_DATA=true npm run demo-barcodes --workspace @trustme/api -- purge --all
```

The read-only statistics command is:

```text
npm run demo-barcodes --workspace @trustme/api -- stats
```

Generation accepts `--min-coupons`, `--max-coupons`, and `--batch` (default
500). It is safe to rerun for the same reserved indexes. Purge removes demo
users oldest first and refuses unsafe rows if any ledger entry touches a
non-demo account; it never cascades into real users or their accounts.
Administrative overview displays demo circulation and user count in a separate
block from real circulation and solvency. If a member is quarantined after a
PIN reset, the admin member/withdrawal view shows the quarantine timestamp and
the `pin_reset_quarantine` blocker.

The exact production generation invocation, from the TrustMe release directory,
is:

```text
cd /opt/trustme/current
ALLOW_DEMO_DATA=true npm run demo-barcodes --workspace @trustme/api -- generate --count 5000 --min-coupons 1 --max-coupons 10 --batch 500
```

The worker's optional demo circulation job is controlled by these environment
variables:

```text
ALLOW_DEMO_DATA=false
DEMO_CHURN_INTERVAL_MS=30000
DEMO_CHURN_TRANSFERS_PER_TICK=3
DEMO_CHURN_MAX_COUPONS=50
```

When `ALLOW_DEMO_DATA=true`, the worker transfers bounded amounts only between
funded demo users. Demo coupons are issued from `SYSTEM_DEMO_ISSUANCE`, never
affect real reserves or solvency, and are always labelled `Demo / Testdata` in
public output. Turning the flag off removes the scheduled demo churn job.

* distinct TrustMe API and admin hostnames;
* TLS certificates and certbot policy;
* Polygon RPC URL, deposit xpub, hot-wallet address/private key, API token,
  admin JWT secret, database/Redis/replication passwords;
* SSH keys and authorization for deployment, fencing, and replication;
* a reviewed git repository ref and DNS access.

No real credentials belong in this repository. These scripts have not been
executed against the servers yet, and production installation, replication,
promotion, DNS, TLS, and failback remain unverified until an authorized
operator runs them.

## Browser origins

The API answers browser requests only for origins listed in
`API_ALLOWED_ORIGINS` (comma-separated, scheme included), for example
`https://app-trustcoupon.komasi.as,https://komasi.as`. Without it the API sends
no `Access-Control-Allow-Origin` header, so the browser drops every API call
from the web app — including the social sign-in token exchange, which then
returns the user to the login screen with no server-side error to inspect.
Verify after deployment:

```
curl -si -X OPTIONS https://<api-host>/v1/auth/google \
  -H 'Origin: https://<web-host>' \
  -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin
```

## Web Apple sign-in

Web Apple sign-in requires the Services ID to be set as
`EXPO_PUBLIC_APPLE_WEB_CLIENT_ID` at web export time and appended to the API's
`APPLE_OAUTH_AUDIENCES`. The web origin must also be registered as the domain
and return URL for the Services ID in the Apple Developer portal.
