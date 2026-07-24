# @absolutejs/agency

Provider-neutral action authorization for AI agents.

Authentication says which agent is acting and on whose behalf. Agency decides
whether that exact action may happen now, coordinates prerequisites such as
human approval or terminal human rejection, issues a short-lived single-use
execution lease, and records a receipt after execution.

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

if (decision.kind === "deny" && decision.requestable) {
  await agency.reject({
    actionId: action.actionId,
    reason: "The recipient is outside the approved customer account.",
    rejectedBy: "operator-123",
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

`createAgentDelegationAuthority()` issues durable, revocable delegation grants
inside Agency. Every child must attenuate its parent's user, audience, expiry,
action scopes, effects, resource boundaries, and spend ceiling; delegation
depth is bounded and revocation cascades to descendants. Pass the authority as
`createAgency({ delegations: authority, ... })` to re-check the complete active
chain when an action is requested, when its execution lease is issued, and
immediately before that lease is consumed.

```ts
const delegations = createAgentDelegationAuthority({
  audience: "https://app.example",
  store: createMemoryAgentDelegationStore(), // use PostgreSQL in production
});

const grant = await delegations.issue({
  audience: "https://app.example",
  issuerAgentId: "user-agent",
  subjectAgentId: "calendar-agent",
  userId: "user-1",
  scopes: ["calendar.create"],
  effects: ["write", "external-network"],
  resourceTypes: ["calendar"],
  expiresAt: Date.now() + 3_600_000,
});
```

- `signAgentHandoff()` / `verifyAgentHandoff()` create audience-bound,
  expiring, replay-protected agent-to-agent capability envelopes. Use
  `attenuateAgentHandoff()` for additional hops so scopes, spend, expiry, and
  user identity cannot escalate.
- `signAgentHandoffWith()` / `verifyAgentHandoffWith()` accept independent
  signer and verifier providers over canonical bytes. Cloud KMS/HSM adapters
  can keep private keys non-exportable, rotate by `keyId`, and reject algorithms
  without changing the handoff wire contract. HS256 remains available for
  compatibility and local development.
- `simulateAction()` evaluates policy and produces the same canonical binding
  without storing an action, issuing a lease, or running an effect.
- `createAgencyTelemetryEmitter()` maps every Agency event to stable
  `agent.*` event names and attributes that can feed OpenTelemetry or any audit
  sink without coupling the core package to a telemetry vendor.

Memory stores are development defaults. Production deployments should supply
durable, transactional stores for Agency state, kill switches, and handoff
nonces.

### PostgreSQL production state

`agencyPostgresSchemaSql()` creates indexed tables for actions, approvals,
rejections, leases, receipts, kill switches, and replay nonces. The adapters
accept a small structural `AgencySqlClient`, so Bun SQL, Neon, `pg`, and
transaction-aware host clients can be used without coupling the core package to
a database driver.

```ts
const store = createPostgresAgencyStore({ client: sqlClient });
const controlStore = createPostgresAgentControlStore({ client: sqlClient });
const replayStore = createPostgresHandoffReplayStore({ client: sqlClient });
```

Lease consumption is one conditional `UPDATE`, making concurrent execution
attempts safe across processes. Handoff nonces are persisted as SHA-256 digests,
not bearer values. Apply `agencyPostgresSchemaSql()` during deployment before
starting workers.

Security invariants:

- Approval and rejection are bound to the canonical action, actor, resource,
  effects, input digest, spend, and expiry.
- Approval-versus-rejection decisions are first-writer-wins, including across
  PostgreSQL processes; a later concurrent decision cannot replace the original
  operator decision.
- A rejected action can never receive an execution lease.
- Policy is re-evaluated after approval and immediately before issuing a lease.
- Execution leases are short-lived and single-use.
- A consumed lease remains consumed when provider execution fails.
- Successful and failed executions produce receipts.
- The default policy helper is deny-all; permissive policy is explicit.

## License

MIT
