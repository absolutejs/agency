import type {
  ActionApproval,
  ActionReceipt,
  ActionRejection,
  ActionRequest,
  AgencyStore,
  ExecutionLease,
} from "./types";

const clone = <Value>(value: Value): Value => structuredClone(value);

export type MemoryAgencyStore = AgencyStore & {
  /**
   * Overwrite a stored action, bypassing the idempotency guard on
   * `saveAction`. This is the only way to simulate an out-of-band mutation —
   * a record edited behind the engine's back — which is what the
   * approval-input-binding conformance scenario has to reproduce to prove
   * `issueLease` rejects an action whose input changed after approval.
   *
   * Not part of {@link AgencyStore}: production code has no reason to replace
   * an action, and durable stores should not offer it.
   */
  replaceAction: (action: ActionRequest) => Promise<void>;
};

/**
 * In-memory store for tests and conformance harnesses.
 *
 * Returns {@link MemoryAgencyStore} rather than a bare {@link AgencyStore} so a
 * harness can reach `replaceAction` — see the note there.
 */
export const createMemoryAgencyStore = (): MemoryAgencyStore => {
  const actions = new Map<string, ActionRequest>();
  const approvals = new Map<string, ActionApproval>();
  const leases = new Map<string, ExecutionLease>();
  const receipts = new Map<string, ActionReceipt>();
  const rejections = new Map<string, ActionRejection>();
  const actorForAction = (actionId: string) =>
    actions.get(actionId)?.actor.agentId;

  return {
    consumeLease: async (leaseId, consumedAt) => {
      const lease = leases.get(leaseId);
      if (lease === undefined || lease.consumedAt !== undefined) return false;
      leases.set(leaseId, { ...lease, consumedAt });

      return true;
    },
    getAction: async (actionId) => {
      const action = actions.get(actionId);

      return action === undefined ? undefined : clone(action);
    },
    getApproval: async (actionId) => {
      const approval = approvals.get(actionId);

      return approval === undefined ? undefined : clone(approval);
    },
    getLease: async (leaseId) => {
      const lease = leases.get(leaseId);

      return lease === undefined ? undefined : clone(lease);
    },
    getRejection: async (actionId) => {
      const rejection = rejections.get(actionId);

      return rejection === undefined ? undefined : clone(rejection);
    },
    listActions: async (actorId) =>
      [...actions.values()]
        .filter(
          (action) => actorId === undefined || action.actor.agentId === actorId,
        )
        .map(clone),
    listApprovals: async (actorId) =>
      [...approvals.values()]
        .filter(
          (approval) =>
            actorId === undefined ||
            actorForAction(approval.actionId) === actorId,
        )
        .map(clone),
    listLeases: async (actorId) =>
      [...leases.values()]
        .filter(
          (lease) =>
            actorId === undefined || actorForAction(lease.actionId) === actorId,
        )
        .map(clone),
    listReceipts: async (actorId) =>
      [...receipts.values()]
        .filter(
          (receipt) =>
            actorId === undefined ||
            actorForAction(receipt.actionId) === actorId,
        )
        .map(clone),
    listRejections: async (actorId) =>
      [...rejections.values()]
        .filter(
          (rejection) =>
            actorId === undefined ||
            actorForAction(rejection.actionId) === actorId,
        )
        .map(clone),
    replaceAction: async (action) => {
      actions.set(action.actionId, clone(action));
    },
    // Deliberately does NOT overwrite: request() saves, re-reads, and compares,
    // which is how a reused idempotency key carrying a different payload is
    // detected. Overwriting here would make that check compare the action to
    // itself and silently accept the swap.
    saveAction: async (action) => {
      if (!actions.has(action.actionId))
        actions.set(action.actionId, clone(action));
    },
    saveApproval: async (approval) => {
      if (approvals.has(approval.actionId) || rejections.has(approval.actionId))
        return false;
      approvals.set(approval.actionId, clone(approval));

      return true;
    },
    saveLease: async (lease) => {
      leases.set(lease.leaseId, clone(lease));
    },
    saveReceipt: async (receipt) => {
      receipts.set(receipt.receiptId, clone(receipt));
    },
    saveRejection: async (rejection) => {
      if (
        approvals.has(rejection.actionId) ||
        rejections.has(rejection.actionId)
      )
        return false;
      rejections.set(rejection.actionId, clone(rejection));

      return true;
    },
  };
};
