import type { AuditEvidenceMode } from './types.js';

export type InteractionVideoPhase = 'initial-state' | 'before-action' | 'response' | 'final-outcome' | 'secondary-outcome';

/**
 * Small, deterministic pauses used only by interaction-video executions.
 * They make the starting state, action, response, and final result reviewable
 * without adding delay to screenshot or structured-data audits.
 */
export const INTERACTION_VIDEO_PACING_MS: Readonly<Record<InteractionVideoPhase, number>> = Object.freeze({
  'initial-state': 700,
  'before-action': 200,
  response: 450,
  'final-outcome': 1_100,
  'secondary-outcome': 2_200,
});

export function interactionVideoDelayMs(
  mode: AuditEvidenceMode,
  phase: InteractionVideoPhase,
): number {
  return mode === 'interaction-video' ? INTERACTION_VIDEO_PACING_MS[phase] : 0;
}
