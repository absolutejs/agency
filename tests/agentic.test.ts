import { describe, expect, test } from "bun:test";
import {
  agencyEventToTelemetry,
  allowAllPolicy,
  attenuateAgentHandoff,
  createAgentControlPlane,
  createAgency,
  createMemoryAgentControlStore,
  createMemoryAgencyStore,
  createMemoryHandoffReplayStore,
  signAgentHandoff,
  simulateAction,
  verifyAgentHandoff,
  type AgentHandoffClaims,
} from "../src";

const actionInput = {
  action: "send_message",
  actor: { agentId: "agent-1", scopes: ["send"], userId: "user-1" },
  effects: ["send"] as const,
  input: { body: "hello" },
  resource: { id: "recipient-1", type: "recipient" },
};

describe("agent control plane", () => {
  test("activates the kill switch before revoking every source", async () => {
    const store = createMemoryAgentControlStore();
    const states: boolean[] = [];
    const control = createAgentControlPlane({
      now: () => 100,
      sources: [
        {
          inventory: async () => [],
          name: "auth",
          revoke: async (agentId) => {
            states.push((await store.getKillSwitch(agentId)) !== undefined);
            return 2;
          },
        },
        {
          inventory: async () => [],
          name: "wallet",
          revoke: async () => {
            throw new Error("wallet offline");
          },
        },
      ],
      store,
    });
    const result = await control.revoke({
      activatedBy: "operator-1",
      agentId: "agent-1",
      reason: "incident",
    });
    expect(states).toEqual([true]);
    expect(result.results[1]?.status).toBe("rejected");
    await expect(control.assertActive("agent-1")).rejects.toThrow("incident");
    const agency = createAgency({
      control,
      policy: allowAllPolicy(),
      store: createMemoryAgencyStore(),
    });
    await expect(agency.request(actionInput)).rejects.toThrow("incident");
    await control.restore("agent-1");
    await control.assertActive("agent-1");
  });

  test("isolates source errors while building inventory", async () => {
    const control = createAgentControlPlane({
      sources: [
        {
          inventory: async () => [
            {
              id: "grant-1",
              kind: "credential",
              source: "secrets",
              status: "active",
            },
          ],
          name: "secrets",
          revoke: async () => 1,
        },
        {
          inventory: async () => {
            throw new Error("unavailable");
          },
          name: "mcp",
          revoke: async () => 0,
        },
      ],
      store: createMemoryAgentControlStore(),
    });
    const inventory = await control.inventory("agent-1");
    expect(inventory.items).toHaveLength(1);
    expect(inventory.sourceErrors).toEqual([
      { error: "unavailable", source: "mcp" },
    ]);
  });
});

describe("simulation and telemetry", () => {
  test("dry-runs policy without persisting or issuing a lease", async () => {
    const result = await simulateAction({
      input: actionInput,
      now: () => 50,
      policy: allowAllPolicy(),
    });
    expect(result.dryRun).toBe(true);
    expect(result.wouldExecute).toBe(true);
    expect(result.action.actionId).toStartWith("sim_");
  });

  test("normalizes agency events into agent telemetry attributes", () => {
    const record = agencyEventToTelemetry(
      {
        action: {
          ...actionInput,
          actionId: "act-1",
          createdAt: 1,
          inputDigest: "abc",
        },
        type: "action.requested",
      },
      25,
    );
    expect(record.name).toBe("agent.action.requested");
    expect(record.attributes["agent.id"]).toBe("agent-1");
  });
});

describe("signed agent handoffs", () => {
  const claims: Omit<AgentHandoffClaims, "version"> = {
    action: "research",
    audience: "agent-b",
    delegationId: "delegation-1",
    expiresAt: 1_000,
    handoffId: "handoff-1",
    inputDigest: "digest-1",
    issuedAt: 100,
    issuerAgentId: "agent-a",
    nonce: "nonce-1",
    scopes: ["web:read"],
    spendLimit: { amountMinor: 500, currency: "USD" },
    subjectAgentId: "agent-b",
    userId: "user-1",
  };

  test("binds audience and rejects replay and tampering", async () => {
    const handoff = await signAgentHandoff({
      claims,
      key: "a-long-handoff-key",
      keyId: "key-1",
    });
    const replayStore = createMemoryHandoffReplayStore(() => 100);
    const verified = await verifyAgentHandoff({
      expectedAudience: "agent-b",
      handoff,
      key: "a-long-handoff-key",
      now: () => 100,
      replayStore,
    });
    expect(verified.scopes).toEqual(["web:read"]);
    await expect(
      verifyAgentHandoff({
        expectedAudience: "agent-b",
        handoff,
        key: "a-long-handoff-key",
        now: () => 100,
        replayStore,
      }),
    ).rejects.toThrow("already been consumed");
    await expect(
      verifyAgentHandoff({
        expectedAudience: "agent-c",
        handoff,
        key: "a-long-handoff-key",
        now: () => 100,
        replayStore: createMemoryHandoffReplayStore(() => 100),
      }),
    ).rejects.toThrow("audience mismatch");
    await expect(
      verifyAgentHandoff({
        expectedAudience: "agent-b",
        handoff: {
          ...handoff,
          claims: { ...handoff.claims, action: "delete" },
        },
        key: "a-long-handoff-key",
        now: () => 100,
        replayStore: createMemoryHandoffReplayStore(() => 100),
      }),
    ).rejects.toThrow("signature");
  });

  test("attenuates scope, expiry, user, and spend across hops", () => {
    expect(() =>
      attenuateAgentHandoff(
        { ...claims, version: "absolute.agent-handoff/1" },
        { ...claims, handoffId: "child", scopes: ["web:read", "admin"] },
      ),
    ).toThrow("scopes");
    expect(() =>
      attenuateAgentHandoff(
        { ...claims, version: "absolute.agent-handoff/1" },
        {
          ...claims,
          handoffId: "child",
          spendLimit: { amountMinor: 501, currency: "USD" },
        },
      ),
    ).toThrow("spend");
  });
});
