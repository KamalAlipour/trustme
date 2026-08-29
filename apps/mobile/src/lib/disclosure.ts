export type DisclosureApprovalDisplay = {
  requestId: string;
  code: string;
  expiresAt: string;
};

export function approvalDisplay(requestId: string, code: string, expiresAt: string): DisclosureApprovalDisplay {
  return { requestId, code, expiresAt };
}
