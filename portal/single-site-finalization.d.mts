export interface PublicSingleSiteFinalizationStatus {
  schemaVersion: 1;
  jobId: string;
  status: 'pending' | 'complete' | 'incomplete' | 'deadline-exceeded' | 'invalid';
  deadlineExceeded: boolean;
  executionState: string | null;
  finalizationDigest: string | null;
  failureDigest: string | null;
  reportRevision: string | null;
  reportPublicationDigest: string | null;
  visualPublicationDigest: string | null;
  visualEligibilityManifestDigest: string | null;
  mediaStageDigest: string | null;
  mediaQualityState: 'complete' | 'incomplete' | null;
  galleryPublicationDigest: string | null;
  galleryExportRevision: string | null;
  galleryIndexDigest: string | null;
  publicationBlocked: boolean;
}

export function readSingleSiteFinalizationStatus(
  root: string,
  jobId: string,
): Promise<PublicSingleSiteFinalizationStatus>;
