export interface ShadowProductionDerivationReceipt {
  caseId: string;
  side: 'legacy' | 'shared';
  productionFunction: string;
  detail: string | null;
}

export function buildProductionDerivedShadowMatrix(options?: {
  observe?: (receipt: ShadowProductionDerivationReceipt) => void;
}): Promise<{
  cases: unknown[];
  intentionalDifferences: unknown[];
}>;
