import { expect, test } from "bun:test";
import {
  createAuthzenPolicyDecisionPoint,
  createCoazActionInput,
  toAarpAccessRequest,
  toAuthzenEvaluation,
} from "../src/authzen";
import type { ActionRequest } from "../src";

const action: ActionRequest = {
  action: "call_tool",
  actionId: "action-1",
  actor: { agentId: "agent-1", scopes: ["crm:write"], userId: "user-1" },
  createdAt: 1,
  effects: ["write"],
  inputDigest: "digest",
  resource: { id: "create_contact", type: "mcp_tool" },
};

test("maps agent actions to AuthZEN SARC without changing the core contract", () => {
  const evaluation = toAuthzenEvaluation(action);
  expect(evaluation.subject.properties?.act).toEqual({
    id: "agent-1",
    type: "agent",
  });
  expect(evaluation.resource.id).toBe("create_contact");
});

test("maps requestable AuthZEN denials and AARP submissions", async () => {
  const policy = createAuthzenPolicyDecisionPoint({
    evaluationEndpoint: "https://pdp.example/access/v1/evaluation",
    fetch: async () =>
      new Response(
        JSON.stringify({
          context: {
            access_request: { template: "manager", title: "Ask manager" },
            evaluation_id: "evaluation-1",
            reason: "approval_required",
          },
          decision: false,
        }),
      ),
  });
  const decision = await policy.evaluate({ action, now: 10 });
  if (decision.kind !== "deny") throw new Error("Expected denial");
  expect(decision.requestable).toBe(true);
  expect(toAarpAccessRequest(action, decision).denial.evaluation_id).toBe(
    "evaluation-1",
  );
});

test("creates COAZ-shaped MCP action inputs", () => {
  const input = createCoazActionInput({
    actor: action.actor,
    call: {
      arguments: { name: "Ada" },
      name: "create_contact",
      serverId: "crm",
    },
    effects: ["write"],
  });
  expect(input.resource.type).toBe("mcp_tool");
  expect(input.action).toBe("call_tool");
});
