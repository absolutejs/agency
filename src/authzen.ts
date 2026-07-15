import type {
  ActionApproval,
  ActionDecision,
  ActionRequest,
  ApprovalPrerequisite,
  PolicyDecisionPoint,
} from "./types";

export type AuthzenEntity = {
  id: string;
  properties?: Record<string, unknown>;
  type: string;
};

export type AuthzenEvaluationRequest = {
  action: AuthzenEntity;
  context?: Record<string, unknown>;
  resource: AuthzenEntity;
  subject: AuthzenEntity;
};

export type AuthzenEvaluationResponse = {
  context?: Record<string, unknown>;
  decision: boolean;
};

export type AuthzenClientOptions = {
  authorization?: string | (() => Promise<string> | string);
  evaluationEndpoint: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const toSubject = (action: ActionRequest): AuthzenEntity => ({
  id: action.actor.userId,
  properties: {
    act: {
      id: action.actor.agentId,
      type: "agent",
    },
    delegation_id: action.actor.delegationId,
    organization_id: action.actor.organizationId,
    scopes: action.actor.scopes,
  },
  type: "user",
});

export const toAuthzenEvaluation = (
  action: ActionRequest,
  approval?: ActionApproval,
): AuthzenEvaluationRequest => ({
  action: { id: action.action, type: "action" },
  context: {
    ...action.context,
    action_id: action.actionId,
    approval:
      approval === undefined
        ? undefined
        : {
            approved_at: new Date(approval.approvedAt).toISOString(),
            approved_until: new Date(approval.approvedUntil).toISOString(),
            id: approval.approvalId,
            state: approval.state,
          },
    effects: action.effects,
    input_digest: action.inputDigest,
    spend: action.spend,
  },
  resource: action.resource,
  subject: toSubject(action),
});

const readPrerequisites = (context: Record<string, unknown> | undefined) => {
  const accessRequest = context?.access_request;
  if (accessRequest === null || typeof accessRequest !== "object")
    return undefined;
  const value = accessRequest as Record<string, unknown>;
  const prerequisite: ApprovalPrerequisite = {
    description:
      typeof value.description === "string" ? value.description : undefined,
    kind: "approval",
    metadata: value,
    prerequisiteId:
      typeof value.template === "string"
        ? value.template
        : "authzen-access-request",
    title: typeof value.title === "string" ? value.title : "Request access",
  };

  return [prerequisite];
};

const decisionFromAuthzen = (
  response: AuthzenEvaluationResponse,
  now: number,
): ActionDecision => {
  const decisionId =
    typeof response.context?.evaluation_id === "string"
      ? response.context.evaluation_id
      : `az_${crypto.randomUUID()}`;
  if (response.decision) {
    return {
      decisionId,
      evaluatedAt: now,
      kind: "allow",
      metadata: response.context,
    };
  }
  const prerequisites = readPrerequisites(response.context);

  return {
    decisionId,
    evaluatedAt: now,
    kind: "deny",
    metadata: response.context,
    prerequisites,
    reason:
      typeof response.context?.reason === "string"
        ? response.context.reason
        : "policy_denied",
    requestable: prerequisites !== undefined,
  };
};

export const createAuthzenPolicyDecisionPoint = ({
  authorization,
  evaluationEndpoint,
  fetch: fetchImplementation = globalThis.fetch,
}: AuthzenClientOptions): PolicyDecisionPoint => ({
  evaluate: async ({ action, approval, now }) => {
    const credential =
      typeof authorization === "function"
        ? await authorization()
        : authorization;
    const response = await fetchImplementation(evaluationEndpoint, {
      body: JSON.stringify(toAuthzenEvaluation(action, approval)),
      headers: {
        ...(credential === undefined ? {} : { authorization: credential }),
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok)
      throw new Error(`AuthZEN evaluation failed (${response.status})`);
    const body = (await response.json()) as AuthzenEvaluationResponse;

    return decisionFromAuthzen(body, now);
  },
});

export type AarpAccessRequest = {
  action: AuthzenEntity;
  context?: Record<string, unknown>;
  denial: { binding_token?: string; evaluation_id?: string; reason?: string };
  requested_access?: Record<string, unknown>;
  resource: AuthzenEntity;
  subject: AuthzenEntity;
};

export const toAarpAccessRequest = (
  action: ActionRequest,
  decision: Extract<ActionDecision, { kind: "deny" }>,
  requestedAccess?: Record<string, unknown>,
): AarpAccessRequest => {
  const evaluation = toAuthzenEvaluation(action);
  const bindingToken = decision.metadata?.binding_token;

  return {
    action: evaluation.action,
    context: evaluation.context,
    denial: {
      binding_token:
        typeof bindingToken === "string" ? bindingToken : undefined,
      evaluation_id: decision.decisionId,
      reason: decision.reason,
    },
    requested_access: requestedAccess,
    resource: evaluation.resource,
    subject: evaluation.subject,
  };
};

export type CoazToolCall = {
  arguments?: unknown;
  name: string;
  serverId: string;
};

export const createCoazActionInput = ({
  actor,
  call,
  effects = ["read"],
  requiredScopes = [],
}: {
  actor: ActionRequest["actor"];
  call: CoazToolCall;
  effects?: ActionRequest["effects"];
  requiredScopes?: ReadonlyArray<string>;
}) => ({
  action: "call_tool",
  actor,
  context: { required_scopes: requiredScopes, source: "mcp" },
  effects,
  input: call.arguments,
  resource: {
    id: call.name,
    properties: { server_id: call.serverId },
    type: "mcp_tool",
  },
});
