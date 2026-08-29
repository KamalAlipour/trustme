export type IdentityVerificationMode = 'AUTOMATED' | 'MANUAL';
export type IdentityProviderKey = 'SHAHKAR' | 'BANKID_NO' | 'BANKID_SE' | 'MITID_DK'
  | 'FTN_FI' | 'IDIN_NL' | 'ITSME_BE' | 'EID_DE' | 'SMARTID_EE' | 'SMARTID_LV'
  | 'SMARTID_LT' | 'AADHAAR_IN' | 'IDSP_GB';
export type CountryIdentityPolicy = {
  country: string;
  mode: IdentityVerificationMode;
  provider: IdentityProviderKey | null;
  providerLabel: string | null;
  plannedProviderLabel: string | null;
};
export type IdentityProviderAccess = { shahkar: boolean };
const registry: Array<{ country: string; provider: IdentityProviderKey; providerLabel: string; implemented: boolean }> = [
  { country: 'IR', provider: 'SHAHKAR', providerLabel: 'Shahkar', implemented: true },
  { country: 'NO', provider: 'BANKID_NO', providerLabel: 'BankID', implemented: false },
  { country: 'SE', provider: 'BANKID_SE', providerLabel: 'BankID (Sweden)', implemented: false },
  { country: 'DK', provider: 'MITID_DK', providerLabel: 'MitID', implemented: false },
  { country: 'FI', provider: 'FTN_FI', providerLabel: 'Finnish Trust Network (FTN)', implemented: false },
  { country: 'NL', provider: 'IDIN_NL', providerLabel: 'iDIN', implemented: false },
  { country: 'BE', provider: 'ITSME_BE', providerLabel: 'itsme', implemented: false },
  { country: 'DE', provider: 'EID_DE', providerLabel: 'eID (Personalausweis) / eIDAS node', implemented: false },
  { country: 'EE', provider: 'SMARTID_EE', providerLabel: 'Smart-ID / Mobile-ID', implemented: false },
  { country: 'LV', provider: 'SMARTID_LV', providerLabel: 'Smart-ID / Mobile-ID', implemented: false },
  { country: 'LT', provider: 'SMARTID_LT', providerLabel: 'Smart-ID / Mobile-ID', implemented: false },
  { country: 'IN', provider: 'AADHAAR_IN', providerLabel: 'Aadhaar (OTP-based eKYC)', implemented: false },
  { country: 'GB', provider: 'IDSP_GB', providerLabel: 'Certified IDSP under the DIATF', implemented: false },
];
export function identityPolicyFor(country: string, access: IdentityProviderAccess): CountryIdentityPolicy {
  const normalized = country.trim().toUpperCase();
  const row = registry.find((item) => item.country === normalized);
  if (!row) return { country: normalized, mode: 'MANUAL', provider: null, providerLabel: null, plannedProviderLabel: null };
  if (!row.implemented || (row.provider === 'SHAHKAR' && !access.shahkar)) {
    return { country: normalized, mode: 'MANUAL', provider: null, providerLabel: null, plannedProviderLabel: row.providerLabel };
  }
  return { country: normalized, mode: 'AUTOMATED', provider: row.provider, providerLabel: row.providerLabel, plannedProviderLabel: null };
}
