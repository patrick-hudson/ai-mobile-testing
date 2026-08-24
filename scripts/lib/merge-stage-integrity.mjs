export function mergeStageIntegrityFailures(stage, resultsAreFresh) {
  const failures = [];
  if (!stage || typeof stage !== 'object') {
    failures.push('merge-reports did not publish a command result');
    return failures;
  }
  if (stage.signal) {
    failures.push(`merge-reports was terminated by ${stage.signal}`);
  }
  if (!Number.isInteger(stage.exitCode) || ![0, 1].includes(stage.exitCode)) {
    failures.push(`merge-reports exited abnormally with code ${stage.exitCode ?? 'unknown'}`);
  }
  if (!resultsAreFresh) {
    failures.push('report merge did not produce fresh structured results');
  }
  return failures;
}

export function mergeResultsAreUsable(stage, resultsAreFresh) {
  return mergeStageIntegrityFailures(stage, resultsAreFresh).length === 0;
}
