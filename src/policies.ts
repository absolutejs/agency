import type { PolicyDecisionPoint } from "./types";

export const allowAllPolicy = (): PolicyDecisionPoint => ({
  evaluate: ({ now }) => ({
    decisionId: `decision_${crypto.randomUUID()}`,
    evaluatedAt: now,
    kind: "allow",
  }),
});

export const denyAllPolicy = (
  reason = "default_deny",
): PolicyDecisionPoint => ({
  evaluate: ({ now }) => ({
    decisionId: `decision_${crypto.randomUUID()}`,
    evaluatedAt: now,
    kind: "deny",
    reason,
    requestable: false,
  }),
});
