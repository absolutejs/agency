import { actionBinding, digest } from "./canonical";
import type {
  ActionApproval,
  ActionReceipt,
  ActionRequest,
  ActionRequestInput,
  AgencyOptions,
  ExecutionLease,
  Money,
} from "./types";

const DEFAULT_LEASE_TTL_MS = 60_000;

const required = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new Error(message);

  return value;
};

export const createAgency = ({
  control,
  delegations,
  defaultLeaseTtlMs = DEFAULT_LEASE_TTL_MS,
  emit,
  now = Date.now,
  policy,
  store,
}: AgencyOptions) => {
  const decide = async (action: ActionRequest, approval?: ActionApproval) => {
    const decision = await policy.evaluate({ action, approval, now: now() });
    await emit?.({
      actionId: action.actionId,
      decision,
      type: "action.decided",
    });

    return decision;
  };

  const request = async (input: ActionRequestInput) => {
    await control?.assertActive(input.actor.agentId);
    const delegation = await delegations?.assertAllows(input);
    const createdAt = now();
    const delegatedExpiry = Math.min(
      input.expiresAt ?? Number.POSITIVE_INFINITY,
      delegation?.expiresAt ?? Number.POSITIVE_INFINITY,
    );
    const action: ActionRequest = {
      ...input,
      ...(Number.isFinite(delegatedExpiry)
        ? { expiresAt: delegatedExpiry }
        : {}),
      actionId: `act_${crypto.randomUUID()}`,
      createdAt,
      inputDigest: await digest(input.input ?? null),
    };
    await store.saveAction(action);
    await emit?.({ action, type: "action.requested" });

    return { action, decision: await decide(action) };
  };

  const approve = async ({
    actionId,
    approvedBy,
    approvedUntil,
    conditions,
    state,
  }: {
    actionId: string;
    approvedBy: string;
    approvedUntil: number;
    conditions?: Record<string, unknown>;
    state?: unknown;
  }) => {
    const action = required(await store.getAction(actionId), "Unknown action");
    const approvedAt = now();
    if (approvedUntil <= approvedAt)
      throw new Error("Approval must expire in the future");
    const approval: ActionApproval = {
      actionId,
      approvalId: `apr_${crypto.randomUUID()}`,
      approvedAt,
      approvedBy,
      approvedUntil,
      bindingDigest: await actionBinding(action),
      conditions,
      state,
    };
    if (!(await store.saveApproval(approval)))
      throw new Error("Action approval has already been decided");
    await emit?.({ actionId, approval, type: "action.approved" });

    return approval;
  };

  const issueLease = async (actionId: string) => {
    const action = required(await store.getAction(actionId), "Unknown action");
    await control?.assertActive(action.actor.agentId);
    const delegation = await delegations?.assertAllows(action);
    const approval = await store.getApproval(actionId);
    const currentTime = now();
    if (action.expiresAt !== undefined && action.expiresAt <= currentTime) {
      throw new Error("Action request has expired");
    }
    if (approval !== undefined) {
      if (approval.approvedUntil <= currentTime)
        throw new Error("Approval has expired");
      if (approval.bindingDigest !== (await actionBinding(action))) {
        throw new Error("Approval is not bound to the current action");
      }
    }
    const decision = await decide(action, approval);
    if (decision.kind !== "allow")
      throw new Error(`Action denied: ${decision.reason}`);
    const issuedAt = now();
    const lease: ExecutionLease = {
      actionId,
      bindingDigest: await actionBinding(action),
      expiresAt: Math.min(
        issuedAt + defaultLeaseTtlMs,
        action.expiresAt ?? Number.POSITIVE_INFINITY,
        delegation?.expiresAt ?? Number.POSITIVE_INFINITY,
        approval?.approvedUntil ?? Number.POSITIVE_INFINITY,
        decision.expiresAt ?? Number.POSITIVE_INFINITY,
      ),
      issuedAt,
      leaseId: `lease_${crypto.randomUUID()}`,
      maximumUses: 1,
    };
    await store.saveLease(lease);
    await emit?.({ actionId, lease, type: "action.lease-issued" });

    return lease;
  };

  const execute = async <Result>({
    costs,
    executor,
    leaseId,
    run,
  }: {
    costs?: ReadonlyArray<Money>;
    executor: string;
    leaseId: string;
    run: () => Promise<Result> | Result;
  }) => {
    const lease = required(
      await store.getLease(leaseId),
      "Unknown execution lease",
    );
    const action = required(
      await store.getAction(lease.actionId),
      "Unknown action",
    );
    await control?.assertActive(action.actor.agentId);
    await delegations?.assertAllows(action);
    const startedAt = now();
    if (lease.expiresAt <= startedAt)
      throw new Error("Execution lease has expired");
    if (lease.bindingDigest !== (await actionBinding(action))) {
      throw new Error("Execution lease is not bound to the current action");
    }
    if (!(await store.consumeLease(leaseId, startedAt))) {
      throw new Error("Execution lease has already been consumed");
    }
    let result: Result;
    let receipt: ActionReceipt;
    try {
      result = await run();
      receipt = {
        actionId: action.actionId,
        completedAt: now(),
        costs,
        executor,
        leaseId,
        receiptId: `rcpt_${crypto.randomUUID()}`,
        resultDigest: await digest(result),
        startedAt,
        status: "succeeded",
      };
    } catch (error) {
      receipt = {
        actionId: action.actionId,
        completedAt: now(),
        costs,
        error: error instanceof Error ? error.message : "Action failed",
        executor,
        leaseId,
        receiptId: `rcpt_${crypto.randomUUID()}`,
        startedAt,
        status: "failed",
      };
      await store.saveReceipt(receipt);
      await emit?.({
        actionId: action.actionId,
        receipt,
        type: "action.completed",
      });
      throw error;
    }
    await store.saveReceipt(receipt);
    await emit?.({
      actionId: action.actionId,
      receipt,
      type: "action.completed",
    });

    return { receipt, result };
  };

  const inspect = async (actorId?: string) => ({
    actions: await store.listActions(actorId),
    approvals: await store.listApprovals(actorId),
    leases: await store.listLeases(actorId),
    receipts: await store.listReceipts(actorId),
  });

  return { approve, execute, inspect, issueLease, request };
};

export type Agency = ReturnType<typeof createAgency>;
