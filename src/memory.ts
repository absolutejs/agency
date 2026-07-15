import type {
  ActionApproval,
  ActionReceipt,
  ActionRequest,
  AgencyStore,
  ExecutionLease,
} from "./types";

const clone = <Value>(value: Value): Value => structuredClone(value);

export const createMemoryAgencyStore = (): AgencyStore => {
  const actions = new Map<string, ActionRequest>();
  const approvals = new Map<string, ActionApproval>();
  const leases = new Map<string, ExecutionLease>();
  const receipts = new Map<string, ActionReceipt>();
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
    saveAction: async (action) => {
      actions.set(action.actionId, clone(action));
    },
    saveApproval: async (approval) => {
      approvals.set(approval.actionId, clone(approval));
    },
    saveLease: async (lease) => {
      leases.set(lease.leaseId, clone(lease));
    },
    saveReceipt: async (receipt) => {
      receipts.set(receipt.receiptId, clone(receipt));
    },
  };
};
