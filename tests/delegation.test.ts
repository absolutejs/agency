import { describe, expect, test } from "bun:test";
import {
  allowAllPolicy,
  createAgency,
  createAgentDelegationAuthority,
  createMemoryAgencyStore,
  createMemoryAgentDelegationStore,
} from "../src";

describe("durable agent delegation", () => {
  test("attenuates child authority and rechecks revocation before execution", async () => {
    let current = 1_000;
    const delegations = createAgentDelegationAuthority({
      audience: "https://app.example",
      now: () => current,
      store: createMemoryAgentDelegationStore(),
    });
    const root = await delegations.issue({
      audience: "https://app.example",
      effects: ["write", "external-network"],
      expiresAt: 10_000,
      issuerAgentId: "root-agent",
      resourceIds: ["primary"],
      resourceTypes: ["calendar"],
      scopes: ["calendar.create", "calendar.read"],
      spendLimit: { amountMinor: 1000, currency: "USD" },
      subjectAgentId: "planner-agent",
      userId: "user-1",
    });
    const child = await delegations.delegate(root.delegationId, {
      audience: "https://app.example",
      effects: ["write"],
      expiresAt: 9_000,
      issuerAgentId: "planner-agent",
      resourceIds: ["primary"],
      resourceTypes: ["calendar"],
      scopes: ["calendar.create"],
      spendLimit: { amountMinor: 500, currency: "USD" },
      subjectAgentId: "calendar-agent",
      userId: "user-1",
    });
    await expect(
      delegations.delegate(root.delegationId, {
        ...child,
        effects: ["delete"],
        expiresAt: 11_000,
        issuerAgentId: "planner-agent",
        subjectAgentId: "bad-agent",
      }),
    ).rejects.toThrow("escalates");
    await expect(
      delegations.delegate(root.delegationId, {
        audience: "https://app.example",
        effects: ["write"],
        expiresAt: 9_000,
        issuerAgentId: "planner-agent",
        resourceTypes: ["calendar"],
        scopes: ["calendar.create"],
        spendLimit: { amountMinor: 500, currency: "USD" },
        subjectAgentId: "unbounded-agent",
        userId: "user-1",
      }),
    ).rejects.toThrow("escalates");

    const agency = createAgency({
      delegations,
      now: () => current,
      policy: allowAllPolicy(),
      store: createMemoryAgencyStore(),
    });
    const requested = await agency.request({
      action: "calendar.create",
      actor: {
        agentId: "calendar-agent",
        delegationId: child.delegationId,
        scopes: ["calendar.create"],
        userId: "user-1",
      },
      effects: ["write"],
      resource: { id: "primary", type: "calendar" },
      spend: { amountMinor: 250, currency: "USD" },
    });
    expect(requested.action.expiresAt).toBe(9_000);
    const lease = await agency.issueLease(requested.action.actionId);
    expect(await delegations.revoke(root.delegationId)).toBe(2);
    await expect(
      agency.execute({
        executor: "test",
        leaseId: lease.leaseId,
        run: () => true,
      }),
    ).rejects.toThrow("inactive");
  });

  test("denies actor, scope, resource, effect, and spend escalation", async () => {
    const authority = createAgentDelegationAuthority({
      audience: "https://app.example",
      now: () => 1,
      store: createMemoryAgentDelegationStore(),
    });
    const grant = await authority.issue({
      audience: "https://app.example",
      effects: ["read"],
      expiresAt: 100,
      issuerAgentId: "root",
      resourceIds: ["one"],
      resourceTypes: ["record"],
      scopes: ["record.read"],
      subjectAgentId: "reader",
      userId: "user",
    });
    const action = {
      action: "record.read",
      actor: {
        agentId: "reader",
        delegationId: grant.delegationId,
        scopes: ["record.read"],
        userId: "user",
      },
      effects: ["read" as const],
      resource: { id: "one", type: "record" },
    };
    await expect(authority.assertAllows(action)).resolves.toEqual({
      expiresAt: 100,
    });
    await expect(
      authority.assertAllows({ ...action, action: "record.delete" }),
    ).rejects.toThrow("scope");
    await expect(
      authority.assertAllows({
        ...action,
        resource: { id: "two", type: "record" },
      }),
    ).rejects.toThrow("Resource");
  });
});
