import type { SingleSiteReportInput, SingleSiteReportSummary } from './site-health-report.mjs';

export function writeSingleSiteReportPublication(options: {
  outputDir: string;
  input: SingleSiteReportInput;
  publicationRevision?: string;
}): Promise<SingleSiteReportSummary>;
