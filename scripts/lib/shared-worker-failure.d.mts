export interface SharedExecutionFailure {
  kind?: string;
  trustedPlatformSignal?: boolean;
}

export interface ClassifiedExecutionFailure {
  outcome: 'operational_failure' | 'completed_product_failure';
  reason: string;
  retryable: boolean;
}

export function classifyExecutionFailure(value?: SharedExecutionFailure): ClassifiedExecutionFailure;
