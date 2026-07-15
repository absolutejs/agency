import { actionBinding, digest } from "./canonical";
import type {
  ActionApproval,
  ActionRequest,
  ActionRequestInput,
  PolicyDecisionPoint,
} from "./types";

export const simulateAction = async ({
  approval,
  input,
  now = Date.now,
  policy,
}: {
  approval?: ActionApproval;
  input: ActionRequestInput;
  now?: () => number;
  policy: PolicyDecisionPoint;
}) => {
  const evaluatedAt = now();
  const action: ActionRequest = {
    ...input,
    actionId: `sim_${await digest(input)}`,
    createdAt: evaluatedAt,
    inputDigest: await digest(input.input ?? null),
  };
  const decision = await policy.evaluate({
    action,
    approval,
    now: evaluatedAt,
  });

  return {
    action,
    bindingDigest: await actionBinding(action),
    decision,
    dryRun: true as const,
    wouldExecute: decision.kind === "allow",
  };
};
