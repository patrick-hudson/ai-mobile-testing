export const SINGLE_SITE_ADVISORY_SCHEMA_VERSION: 1;

export interface SingleSiteAdvisorySelection {
  schemaVersion: 1;
  aiReview: {
    optedIn: boolean;
    model: string | null;
  };
}

export function disabledSingleSiteAdvisory(): SingleSiteAdvisorySelection;
export function parseSingleSiteAdvisory(value: unknown): SingleSiteAdvisorySelection;
