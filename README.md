# @absolutejs/agency

Provider-neutral action authorization for AI agents.

Authentication says which agent is acting and on whose behalf. Agency decides
whether that exact action may happen now, coordinates prerequisites such as
human approval, issues a short-lived single-use execution lease, and records a
receipt after execution.

```ts
import { createAgency, createMemoryAgencyStore } from "@absolutejs/agency";

const agency = createAgency({
  policy: yourPolicyDecisionPoint,
  store: createMemoryAgencyStore(),
});

const { action, decision } = await agency.request({
  action: "send_email",
  actor: {
    agentId: "sales-agent",
    delegationId: "delegation-123",
    scopes: ["email:send"],
    userId: "user-123",
  },
  effects: ["send", "external-network"],
  input: { subject: "Hello", to: "buyer@example.com" },
  resource: { id: "buyer@example.com", type: "email_recipient" },
});

if (decision.kind === "allow") {
  const lease = await agency.issueLease(action.actionId);
  const { receipt } = await agency.execute({
    executor: "email-provider",
    leaseId: lease.leaseId,
    run: () => email.send(action.input),
  });
}
```

The core contract is deliberately provider-neutral. `@absolutejs/agency/authzen`
contains adapters for the OpenID AuthZEN Authorization API, its Access Request
and Approval Profile (AARP), and MCP tool mappings compatible with the COAZ
profile direction.

## Agentic control plane

`createAgentControlPlane()` inventories an agent's registrations, delegations,
tasks, credential grants, allowances, mandates, leases, and other capabilities
through small `AgentControlSource` adapters. Revocation activates a durable kill
switch first, then fans out cleanup to every source. Pass the control plane to
`createAgency({ control, ... })`; action requests, lease issuance, and execution
then fail closed while the agent is disabled.

## Handoffs, simulation, and telemetry

- `signAgentHandoff()` / `verifyAgentHandoff()` create audience-bound,
  expiring, replay-protected agent-to-agent capability envelopes. Use
  `attenuateAgentHandoff()` for additional hops so scopes, spend, expiry, and
  user identity cannot escalate.
- `simulateAction()` evaluates policy and produces the same canonical binding
  without storing an action, issuing a lease, or running an effect.
- `createAgencyTelemetryEmitter()` maps every Agency event to stable
  `agent.*` event names and attributes that can feed OpenTelemetry or any audit
  sink without coupling the core package to a telemetry vendor.

Memory stores are development defaults. Production deployments should supply
durable, transactional stores for Agency state, kill switches, and handoff
nonces.

Security invariants:

- Approval is bound to the canonical action, actor, resource, effects, input
  digest, spend, and expiry.
- Policy is re-evaluated after approval and immediately before issuing a lease.
- Execution leases are short-lived and single-use.
- A consumed lease remains consumed when provider execution fails.
- Successful and failed executions produce receipts.
- The default policy helper is deny-all; permissive policy is explicit.

## License

MIT
