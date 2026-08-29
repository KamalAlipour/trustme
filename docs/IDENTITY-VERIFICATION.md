# Identity verification and payout requirements

Trust Coupon is intended to operate worldwide. In every country, withdrawing
funds to a bank or other fiat payout requires a verified individual identity
for the account. Identity verification is not a general precondition for using
the app: coupon balances and in-app usage remain available while an account is
unverified.

The verification result is an account-level trust state:
`UNVERIFIED`, `VERIFIED`, `MISMATCH`, or `INCONCLUSIVE`. This state is
deliberately independent of the method that produced it, so the withdrawal
rule can be written once while each country supplies its own verification
method.

The account stores its selected ISO 3166-1 alpha-2 country. The active path is
derived from that country and current provider access: implemented automated
providers are used when reachable, while planned or unavailable providers fall
back to manual review. Withdrawal identity enforcement is controlled by the
`REQUIRE_IDENTITY_FOR_WITHDRAWAL` admin setting, which defaults to enabled.
The country selector, active-path derivation, and withdrawal gate are additive
extensions to the original Shahkar release.

The member-facing country and identity state does not expose national ID
material. Identity checks retain HMAC hashes only, and the audit provider
remains a string so future methods can be recorded without a schema change.

## Method per country

In Iran, the current method is Shahkar: the account holder's mobile number is
checked against the national ID they claim. In other countries, Trust Coupon
will use the country's official identity registry or eID service where one is
reachable. Where no suitable registry is available, the fallback is manual
review by an administrator against a government ID document and a
selfie/liveness check, recorded as the same account-level trust state.

| Country | Reference system | Mode |
| --- | --- | --- |
| Iran | Shahkar (mobile ↔ national ID match, via api.ir ShahkarLite) | Automated — implemented |
| Norway | BankID | Automated — planned |
| Sweden | BankID (Sweden) | Automated — planned |
| Denmark | MitID | Automated — planned |
| Finland | Finnish Trust Network (FTN) | Automated — planned |
| Netherlands | iDIN | Automated — planned |
| Belgium | itsme | Automated — planned |
| Germany | eID (Personalausweis) / eIDAS node | Automated — planned |
| Estonia / Latvia / Lithuania | Smart-ID / Mobile-ID | Automated — planned |
| India | Aadhaar (OTP-based eKYC) | Automated — planned |
| United Kingdom | Certified IDSP under the DIATF | Automated — planned |
| United States | No national registry — document + selfie review | Manual |
| Everywhere else | Government ID document + selfie/liveness, reviewed by an admin | Manual |

Every row except Iran is an intended integration, not a verified contract.
Each provider's onboarding, legal basis, and cost still have to be confirmed
before it is built, and until that happens the country falls back to the
manual row. Every mode, automated or manual, resolves to the same account-level
trust state, so the withdrawal rule never depends on which system produced it.

## Automated vs. manual availability

Each country has exactly one active verification path at any time. The active
path is derived from whether the platform currently has working access to that
country's automated reference system.

When access exists—credentials are provisioned, the contract is live, and the
provider is reachable—the automated path is enabled for that country and the
manual path is disabled. A member in that country cannot choose document review
to bypass the registry, and administrators do not manually approve identities
there. When access does not exist, the automated path is disabled and manual
review using a government ID document plus selfie/liveness, reviewed by an
administrator, is the only route.

Switching a country from manual to automated must not invalidate identities
already verified manually. Existing `VERIFIED` states are retained; the switch
only governs how new verifications are performed. This switch is per-country
operational configuration rather than a code deploy, and it must be auditable:
the audit row records which path produced each verification through its
`provider` string.

Iran today has Shahkar access provisioned, so Iran is automated and its manual
path is closed. This per-country enable/disable mechanism is a required
follow-up alongside the country field. This PR ships only the Shahkar path and
the neutral account-level trust state.

## Iran and Shahkar

The ShahkarLite check verifies that the account holder's Iranian national ID
and mobile number are registered together. Iranian banking counterparties
require the payout beneficiary to own the registered mobile number used for the
account, so a successful match is a precondition for bank payout.

An `INCONCLUSIVE` provider answer means that the registry did not provide a
usable answer. It must never be treated as a mismatch or as grounds to block a
payout; the check retries this transient outcome.

Raw national IDs and mobile numbers are never stored. Only HMAC hashes are
retained for audit and repeat-check purposes, so this record cannot be used as
an identity registry.

## Required follow-ups

The following remain explicitly out of scope for this PR:

- the manual-review path, including document/selfie upload and an admin
  decision;
- future BankID and other country integrations;
- per-country operational enable/disable controls beyond the derived current
  Shahkar access check.

The country field, country-scoped policy selection, and identity requirement
setting are implemented here; the general trust state is now wired into the
withdrawal blocker.
