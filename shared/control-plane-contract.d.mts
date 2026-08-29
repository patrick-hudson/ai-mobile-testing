export type PrincipalKind = 'human' | 'service' | 'worker';
export interface ControlPrincipal {
  id: string;
  kind: PrincipalKind;
  roles: string[];
  projectIds: string[];
  runIds: string[];
  authVersion: number;
}
export declare const CONTROL_ACTIONS: Readonly<Record<string, string>>;
export declare const CONTROL_ROLES: Readonly<Record<string, readonly string[]>>;
export declare class ControlPlaneError extends Error { code: string; statusCode: number }
export declare function validateMutationDeployment(input: {
  bindHost: string; acceptedSocketHost?: string; publishedOrigin: string; sessionSecure: boolean;
}): Readonly<{ local: boolean; publishedOrigin: string; sessionSecure: boolean }>;
export declare function principalActions(principal: ControlPrincipal): Set<string>;
export declare function assertPrincipalAuthorized(principal: ControlPrincipal, action: string,
  object?: { projectId?: string; runId?: string }): ControlPrincipal;
export declare function validateMutationRequest(request: { method: string; headers: Record<string, unknown> }, options: {
  expectedOrigin: string; csrfToken?: string | null; browser?: boolean;
}): true;
