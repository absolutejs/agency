import { digest } from "./canonical";
import type { AgentControlStore, AgentKillSwitch } from "./control";
import type { AgentDelegation, AgentDelegationStore } from "./delegation";
import type { HandoffReplayStore } from "./handoff";
import type { AgencyStore } from "./types";

export type AgencySqlResult<Row> = {
  rowCount: number;
  rows: ReadonlyArray<Row>;
};

export type AgencySqlClient = {
  query: <Row = Record<string, unknown>>(
    sql: string,
    parameters?: ReadonlyArray<unknown>,
  ) => Promise<AgencySqlResult<Row>>;
};

const namespaceOf = (namespace: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(namespace))
    throw new Error("Agency PostgreSQL namespace must be a simple identifier");
  return namespace;
};

export const agencyPostgresSchemaSql = (namespace = "agency") => {
  const ns = namespaceOf(namespace);
  return `CREATE SCHEMA IF NOT EXISTS ${ns};
CREATE TABLE IF NOT EXISTS ${ns}.actions (
  action_id text PRIMARY KEY,
  actor_id text NOT NULL,
  created_at bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_actor_created_idx ON ${ns}.actions (actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ${ns}.approvals (
  action_id text PRIMARY KEY REFERENCES ${ns}.actions(action_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  approved_at bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${ns}.leases (
  lease_id text PRIMARY KEY,
  action_id text NOT NULL REFERENCES ${ns}.actions(action_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  issued_at bigint NOT NULL,
  consumed_at bigint,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${ns}.receipts (
  receipt_id text PRIMARY KEY,
  action_id text NOT NULL REFERENCES ${ns}.actions(action_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  completed_at bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${ns}.kill_switches (
  agent_id text PRIMARY KEY,
  activated_at bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS ${ns}.handoff_nonces (
  nonce_hash text PRIMARY KEY,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS handoff_nonces_expiry_idx ON ${ns}.handoff_nonces (expires_at);
CREATE TABLE IF NOT EXISTS ${ns}.delegations (
  delegation_id text PRIMARY KEY,
  parent_delegation_id text REFERENCES ${ns}.delegations(delegation_id),
  issuer_agent_id text NOT NULL,
  subject_agent_id text NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS delegations_subject_idx ON ${ns}.delegations (subject_agent_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS delegations_issuer_idx ON ${ns}.delegations (issuer_agent_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS delegations_parent_idx ON ${ns}.delegations (parent_delegation_id);`;
};

type DataRow<Value> = { data: Value };

export const createPostgresAgencyStore = ({
  client,
  namespace = "agency",
}: {
  client: AgencySqlClient;
  namespace?: string;
}): AgencyStore => {
  const ns = namespaceOf(namespace);
  const one = async <Value>(sql: string, parameters: ReadonlyArray<unknown>) =>
    (await client.query<DataRow<Value>>(sql, parameters)).rows[0]?.data;
  const many = async <Value>(sql: string, parameters: ReadonlyArray<unknown>) =>
    (await client.query<DataRow<Value>>(sql, parameters)).rows.map(
      ({ data }) => data,
    );
  const actorFor = async (actionId: string) => {
    const row = await client.query<{ actor_id: string }>(
      `SELECT actor_id FROM ${ns}.actions WHERE action_id = $1`,
      [actionId],
    );
    if (row.rows[0] === undefined) throw new Error("Unknown action");
    return row.rows[0].actor_id;
  };

  return {
    consumeLease: async (leaseId, consumedAt) =>
      (
        await client.query(
          `UPDATE ${ns}.leases SET consumed_at = $2, data = jsonb_set(data, '{consumedAt}', to_jsonb($2::bigint), true) WHERE lease_id = $1 AND consumed_at IS NULL`,
          [leaseId, consumedAt],
        )
      ).rowCount === 1,
    getAction: (id) =>
      one(`SELECT data FROM ${ns}.actions WHERE action_id = $1`, [id]),
    getApproval: (id) =>
      one(`SELECT data FROM ${ns}.approvals WHERE action_id = $1`, [id]),
    getLease: (id) =>
      one(`SELECT data FROM ${ns}.leases WHERE lease_id = $1`, [id]),
    listActions: (actorId) =>
      many(
        `SELECT data FROM ${ns}.actions WHERE ($1::text IS NULL OR actor_id = $1) ORDER BY created_at DESC`,
        [actorId ?? null],
      ),
    listApprovals: (actorId) =>
      many(
        `SELECT data FROM ${ns}.approvals WHERE ($1::text IS NULL OR actor_id = $1) ORDER BY approved_at DESC`,
        [actorId ?? null],
      ),
    listLeases: (actorId) =>
      many(
        `SELECT data FROM ${ns}.leases WHERE ($1::text IS NULL OR actor_id = $1) ORDER BY issued_at DESC`,
        [actorId ?? null],
      ),
    listReceipts: (actorId) =>
      many(
        `SELECT data FROM ${ns}.receipts WHERE ($1::text IS NULL OR actor_id = $1) ORDER BY completed_at DESC`,
        [actorId ?? null],
      ),
    saveAction: async (action) => {
      await client.query(
        `INSERT INTO ${ns}.actions (action_id, actor_id, created_at, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (action_id) DO UPDATE SET data = EXCLUDED.data`,
        [
          action.actionId,
          action.actor.agentId,
          action.createdAt,
          JSON.stringify(action),
        ],
      );
    },
    saveApproval: async (approval) => {
      await client.query(
        `INSERT INTO ${ns}.approvals (action_id, actor_id, approved_at, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (action_id) DO UPDATE SET approved_at = EXCLUDED.approved_at, data = EXCLUDED.data`,
        [
          approval.actionId,
          await actorFor(approval.actionId),
          approval.approvedAt,
          JSON.stringify(approval),
        ],
      );
    },
    saveLease: async (lease) => {
      await client.query(
        `INSERT INTO ${ns}.leases (lease_id, action_id, actor_id, issued_at, consumed_at, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (lease_id) DO NOTHING`,
        [
          lease.leaseId,
          lease.actionId,
          await actorFor(lease.actionId),
          lease.issuedAt,
          lease.consumedAt ?? null,
          JSON.stringify(lease),
        ],
      );
    },
    saveReceipt: async (receipt) => {
      await client.query(
        `INSERT INTO ${ns}.receipts (receipt_id, action_id, actor_id, completed_at, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (receipt_id) DO NOTHING`,
        [
          receipt.receiptId,
          receipt.actionId,
          await actorFor(receipt.actionId),
          receipt.completedAt,
          JSON.stringify(receipt),
        ],
      );
    },
  };
};

export const createPostgresAgentControlStore = ({
  client,
  namespace = "agency",
}: {
  client: AgencySqlClient;
  namespace?: string;
}): AgentControlStore => {
  const ns = namespaceOf(namespace);
  return {
    clearKillSwitch: async (agentId) => {
      await client.query(
        `DELETE FROM ${ns}.kill_switches WHERE agent_id = $1`,
        [agentId],
      );
    },
    getKillSwitch: async (agentId) =>
      (
        await client.query<DataRow<AgentKillSwitch>>(
          `SELECT data FROM ${ns}.kill_switches WHERE agent_id = $1`,
          [agentId],
        )
      ).rows[0]?.data,
    setKillSwitch: async (killSwitch) => {
      await client.query(
        `INSERT INTO ${ns}.kill_switches (agent_id, activated_at, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (agent_id) DO UPDATE SET activated_at = EXCLUDED.activated_at, data = EXCLUDED.data`,
        [
          killSwitch.agentId,
          killSwitch.activatedAt,
          JSON.stringify(killSwitch),
        ],
      );
    },
  };
};

export const createPostgresHandoffReplayStore = ({
  client,
  namespace = "agency",
  now = Date.now,
}: {
  client: AgencySqlClient;
  namespace?: string;
  now?: () => number;
}): HandoffReplayStore => {
  const ns = namespaceOf(namespace);
  return {
    consume: async (nonce, expiresAt) => {
      if (expiresAt <= now()) return false;
      const nonceHash = await digest(nonce);
      const result = await client.query(
        `INSERT INTO ${ns}.handoff_nonces (nonce_hash, expires_at) VALUES ($1, $2) ON CONFLICT (nonce_hash) DO NOTHING`,
        [nonceHash, expiresAt],
      );
      return result.rowCount === 1;
    },
  };
};

export const createPostgresAgentDelegationStore = ({
  client,
  namespace = "agency",
}: {
  client: AgencySqlClient;
  namespace?: string;
}): AgentDelegationStore => {
  const ns = namespaceOf(namespace);
  return {
    get: async (id) =>
      (
        await client.query<DataRow<AgentDelegation>>(
          `SELECT data FROM ${ns}.delegations WHERE delegation_id=$1`,
          [id],
        )
      ).rows[0]?.data,
    listForAgent: async (agentId) =>
      (
        await client.query<DataRow<AgentDelegation>>(
          `SELECT data FROM ${ns}.delegations WHERE issuer_agent_id=$1 OR subject_agent_id=$1 ORDER BY expires_at DESC`,
          [agentId],
        )
      ).rows.map(({ data }) => data),
    revokeTree: async (id, revokedAt) =>
      (
        await client.query(
          `WITH RECURSIVE tree AS (SELECT delegation_id FROM ${ns}.delegations WHERE delegation_id=$1 UNION ALL SELECT child.delegation_id FROM ${ns}.delegations child JOIN tree parent ON child.parent_delegation_id=parent.delegation_id) UPDATE ${ns}.delegations SET revoked_at=$2, data=jsonb_set(data,'{revokedAt}',to_jsonb($2::bigint),true) WHERE delegation_id IN (SELECT delegation_id FROM tree) AND revoked_at IS NULL`,
          [id, revokedAt],
        )
      ).rowCount,
    save: async (grant) => {
      const result = await client.query(
        `INSERT INTO ${ns}.delegations (delegation_id,parent_delegation_id,issuer_agent_id,subject_agent_id,expires_at,revoked_at,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (delegation_id) DO NOTHING`,
        [
          grant.delegationId,
          grant.parentDelegationId ?? null,
          grant.issuerAgentId,
          grant.subjectAgentId,
          grant.expiresAt,
          grant.revokedAt ?? null,
          JSON.stringify(grant),
        ],
      );
      if (result.rowCount !== 1) throw new Error("Delegation already exists");
    },
  };
};
