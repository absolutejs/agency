export type AgentActor = {
  agentId: string;
  delegationId?: string;
  organizationId?: string;
  scopes: ReadonlyArray<string>;
  userId: string;
};

export type ActionEffect =
  | "delete"
  | "external-network"
  | "purchase"
  | "read"
  | "send"
  | "transfer"
  | "write"
  | (string & {});

export type Money = {
  amountMinor: number;
  currency: string;
};

export type ActionRequestInput = {
  action: string;
  actor: AgentActor;
  authorizationDetails?: ReadonlyArray<Record<string, unknown>>;
  context?: Record<string, unknown>;
  effects: ReadonlyArray<ActionEffect>;
  expiresAt?: number;
  idempotencyKey?: string;
  input?: unknown;
  resource: {
    id: string;
    properties?: Record<string, unknown>;
    type: string;
  };
  spend?: Money;
};

export type ActionRequest = ActionRequestInput & {
  actionId: string;
  createdAt: number;
  inputDigest: string;
};

export type ApprovalPrerequisite = {
  description?: string;
  kind: "approval" | "attestation" | "consent" | "justification" | "risk-check";
  metadata?: Record<string, unknown>;
  prerequisiteId: string;
  title: string;
};

type DecisionBase = {
  decisionId: string;
  evaluatedAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type ActionDecision =
  | (DecisionBase & { kind: "allow" })
  | (DecisionBase & {
      kind: "deny";
      prerequisites?: ReadonlyArray<ApprovalPrerequisite>;
      reason: string;
      requestable: boolean;
    });

export type ActionApproval = {
  actionId: string;
  approvalId: string;
  approvedAt: number;
  approvedBy: string;
  approvedUntil: number;
  bindingDigest: string;
  conditions?: Record<string, unknown>;
  state?: unknown;
};

export type ExecutionLease = {
  actionId: string;
  bindingDigest: string;
  consumedAt?: number;
  expiresAt: number;
  issuedAt: number;
  leaseId: string;
  maximumUses: 1;
};

export type ActionReceipt = {
  actionId: string;
  completedAt: number;
  costs?: ReadonlyArray<Money>;
  error?: string;
  executor: string;
  leaseId: string;
  receiptId: string;
  resultDigest?: string;
  startedAt: number;
  status: "failed" | "succeeded";
};

export type PolicyEvaluation = {
  action: ActionRequest;
  approval?: ActionApproval;
  now: number;
};

export type PolicyDecisionPoint = {
  evaluate: (
    evaluation: PolicyEvaluation,
  ) => Promise<ActionDecision> | ActionDecision;
};

export type AgencyStore = {
  consumeLease: (leaseId: string, consumedAt: number) => Promise<boolean>;
  getAction: (actionId: string) => Promise<ActionRequest | undefined>;
  getApproval: (actionId: string) => Promise<ActionApproval | undefined>;
  getLease: (leaseId: string) => Promise<ExecutionLease | undefined>;
  listActions: (actorId?: string) => Promise<ReadonlyArray<ActionRequest>>;
  listApprovals: (actorId?: string) => Promise<ReadonlyArray<ActionApproval>>;
  listLeases: (actorId?: string) => Promise<ReadonlyArray<ExecutionLease>>;
  listReceipts: (actorId?: string) => Promise<ReadonlyArray<ActionReceipt>>;
  saveAction: (action: ActionRequest) => Promise<void>;
  /** Atomically stores the first approval for an action. */
  saveApproval: (approval: ActionApproval) => Promise<boolean>;
  saveLease: (lease: ExecutionLease) => Promise<void>;
  saveReceipt: (receipt: ActionReceipt) => Promise<void>;
};

export type AgencyEvent =
  | { action: ActionRequest; type: "action.requested" }
  | { actionId: string; approval: ActionApproval; type: "action.approved" }
  | { actionId: string; decision: ActionDecision; type: "action.decided" }
  | { actionId: string; lease: ExecutionLease; type: "action.lease-issued" }
  | { actionId: string; receipt: ActionReceipt; type: "action.completed" };

export type AgencyOptions = {
  control?: { assertActive: (agentId: string) => Promise<void> | void };
  delegations?: {
    assertAllows: (
      action: ActionRequestInput,
    ) => Promise<{ expiresAt?: number }> | { expiresAt?: number };
  };
  defaultLeaseTtlMs?: number;
  emit?: (event: AgencyEvent) => Promise<void> | void;
  now?: () => number;
  policy: PolicyDecisionPoint;
  store: AgencyStore;
};
