type KycLabels = {
  kycUnverified: string;
  kycPending: string;
  kycVerified: string;
  kycRejected: string;
};

export function kycStatusLabel(status: string, labels: KycLabels): string {
  switch (status) {
    case 'UNVERIFIED': return labels.kycUnverified;
    case 'PENDING': return labels.kycPending;
    case 'VERIFIED': return labels.kycVerified;
    case 'REJECTED': return labels.kycRejected;
    default: return status;
  }
}
