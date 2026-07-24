import type { AgencyEvent } from "./types";

export type AgentTelemetryRecord = {
  attributes: Record<string, boolean | number | string>;
  name: string;
  timestamp: number;
};

export const agencyEventToTelemetry = (
  event: AgencyEvent,
  timestamp = Date.now(),
): AgentTelemetryRecord => {
  const actionId = "action" in event ? event.action.actionId : event.actionId;
  const attributes: Record<string, boolean | number | string> = {
    "agent.action.id": actionId,
    "agent.event.type": event.type,
  };
  if (event.type === "action.requested") {
    attributes["agent.id"] = event.action.actor.agentId;
    attributes["agent.action.name"] = event.action.action;
    attributes["agent.action.effects"] = event.action.effects.join(",");
    attributes["agent.user.id"] = event.action.actor.userId;
  } else if (event.type === "action.decided") {
    attributes["agent.decision.kind"] = event.decision.kind;
    attributes["agent.decision.requestable"] =
      event.decision.kind === "deny" && event.decision.requestable;
  } else if (event.type === "action.lease-issued") {
    attributes["agent.lease.id"] = event.lease.leaseId;
    attributes["agent.lease.expires_at"] = event.lease.expiresAt;
  } else if (event.type === "action.completed") {
    attributes["agent.receipt.id"] = event.receipt.receiptId;
    attributes["agent.execution.status"] = event.receipt.status;
  } else if (event.type === "action.rejected") {
    attributes["agent.rejection.id"] = event.rejection.rejectionId;
    attributes["agent.rejection.by"] = event.rejection.rejectedBy;
  } else {
    attributes["agent.approval.id"] = event.approval.approvalId;
    attributes["agent.approval.by"] = event.approval.approvedBy;
  }

  return { attributes, name: `agent.${event.type}`, timestamp };
};

export const createAgencyTelemetryEmitter =
  (
    emit: (record: AgentTelemetryRecord) => Promise<void> | void,
    now: () => number = Date.now,
  ) =>
  (event: AgencyEvent) =>
    emit(agencyEventToTelemetry(event, now()));
