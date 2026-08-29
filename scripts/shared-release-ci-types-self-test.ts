import type { SharedReleaseCiResult } from './lib/shared-release-ci.mjs';

declare const result: SharedReleaseCiResult;

if (result.stage === 'core') {
  const assertion: null = result.assertionExpected;
  void assertion;
  // @ts-expect-error Core-stage results cannot expose final release assertion authority.
  const authority: string = result.assertionExpected.authority;
  void authority;
} else {
  const authority: string = result.assertionExpected.authority;
  void authority;
  // @ts-expect-error Final-stage results must expose a release assertion contract.
  const absent: null = result.assertionExpected;
  void absent;
}
