import { describe, expect, test } from "bun:test";
import {
  allowAllPolicy,
  createAgency,
  createMemoryAgencyStore,
  type PolicyDecisionPoint,
} from "../src";

const input = {
  action: "send_message",
  actor: {
    agentId: "agent-1",
    delegationId: "delegation-1",
    scopes: ["messages:send"],
    userId: "user-1",
  },
  effects: ["send"] as const,
  input: { body: "hello", recipient: "person@example.com" },
  resource: { id: "person@example.com", type: "recipient" },
};

describe("agency enforcement", () => {
  test("issues a single-use lease and records a receipt", async () => {
    const store = createMemoryAgencyStore();
    const agency = createAgency({ policy: allowAllPolicy(), store });
    const { action, decision } = await agency.request(input);
    expect(decision.kind).toBe("allow");
    const lease = await agency.issueLease(action.actionId);
    const executed = await agency.execute({
      executor: "mcp:messages/send",
      leaseId: lease.leaseId,
      run: () => ({ messageId: "message-1" }),
    });
    expect(executed.receipt.status).toBe("succeeded");
    await expect(
      agency.execute({
        executor: "again",
        leaseId: lease.leaseId,
        run: () => true,
      }),
    ).rejects.toThrow("already been consumed");
  });

  test("requires an exact-bound approval and re-evaluates policy", async () => {
    const policy: PolicyDecisionPoint = {
      evaluate: ({ approval, now }) =>
        approval === undefined
          ? {
              decisionId: "denied-1",
              evaluatedAt: now,
              kind: "deny",
              prerequisites: [
                {
                  kind: "approval",
                  prerequisiteId: "owner",
                  title: "Owner approval",
                },
              ],
              reason: "approval_required",
              requestable: true,
            }
          : {
              decisionId: "allowed-1",
              evaluatedAt: now,
              kind: "allow",
            },
    };
    const agency = createAgency({ policy, store: createMemoryAgencyStore() });
    const { action, decision } = await agency.request(input);
    expect(decision.kind).toBe("deny");
    await agency.approve({
      actionId: action.actionId,
      approvedBy: "user-1",
      approvedUntil: Date.now() + 60_000,
    });
    expect((await agency.issueLease(action.actionId)).maximumUses).toBe(1);
  });

  test("allows only one concurrent approval decision", async () => {
    const agency = createAgency({
      policy: allowAllPolicy(),
      store: createMemoryAgencyStore(),
    });
    const { action } = await agency.request(input);
    const decisions = await Promise.allSettled([
      agency.approve({
        actionId: action.actionId,
        approvedBy: "operator-1",
        approvedUntil: Date.now() + 60_000,
      }),
      agency.approve({
        actionId: action.actionId,
        approvedBy: "operator-2",
        approvedUntil: Date.now() + 60_000,
      }),
    ]);

    expect(
      decisions.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      decisions.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
  });

  test("records failed executions while consuming the lease", async () => {
    const agency = createAgency({
      policy: allowAllPolicy(),
      store: createMemoryAgencyStore(),
    });
    const { action } = await agency.request(input);
    const lease = await agency.issueLease(action.actionId);
    await expect(
      agency.execute({
        executor: "test",
        leaseId: lease.leaseId,
        run: () => {
          throw new Error("provider failed");
        },
      }),
    ).rejects.toThrow("provider failed");
    const ledger = await agency.inspect("agent-1");
    expect(ledger.receipts[0]?.status).toBe("failed");
  });
});
