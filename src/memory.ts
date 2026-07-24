import type {
  ActionApproval,
  ActionReceipt,
  ActionRejection,
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
    saveAction: async (action) => {
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
