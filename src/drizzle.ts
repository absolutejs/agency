import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  pgSchema,
  text,
  type AnyPgColumn,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";
import { digest } from "./canonical";
import type { AgentControlStore, AgentKillSwitch } from "./control";
import type { AgentDelegation, AgentDelegationStore } from "./delegation";
import type { HandoffReplayStore } from "./handoff";
import type {
  ActionApproval,
  ActionReceipt,
  ActionRequest,
  AgencyStore,
  ExecutionLease,
} from "./types";

type AnyPgDatabase = PgAsyncDatabase<any, any>;
const portableJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => JSON.stringify(value),
});
const encodedJsonb = <Value>(value: Value) =>
  sql<Value>`${JSON.stringify(value)}::text::jsonb`;

const namespaceOf = (namespace: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(namespace))
    throw new Error("Agency PostgreSQL namespace must be a simple identifier");
  return namespace;
};

export const agencyDrizzleSchema = (namespace = "agency") => {
  const schema = pgSchema(namespaceOf(namespace));
  const actions = schema.table(
    "actions",
    {
      action_id: text().primaryKey(),
      actor_id: text().notNull(),
      created_at: bigint({ mode: "number" }).notNull(),
      data: portableJsonb().$type<ActionRequest>().notNull(),
    },
    (table) => [
      index("actions_actor_created_idx").on(
        table.actor_id,
        table.created_at.desc(),
      ),
    ],
  );
  const approvals = schema.table("approvals", {
    action_id: text()
      .primaryKey()
      .references(() => actions.action_id, { onDelete: "cascade" }),
    actor_id: text().notNull(),
    approved_at: bigint({ mode: "number" }).notNull(),
    data: portableJsonb().$type<ActionApproval>().notNull(),
  });
  const leases = schema.table("leases", {
    action_id: text()
      .notNull()
      .references(() => actions.action_id, { onDelete: "cascade" }),
    actor_id: text().notNull(),
    consumed_at: bigint({ mode: "number" }),
    data: portableJsonb().$type<ExecutionLease>().notNull(),
    issued_at: bigint({ mode: "number" }).notNull(),
    lease_id: text().primaryKey(),
  });
  const receipts = schema.table("receipts", {
    action_id: text()
      .notNull()
      .references(() => actions.action_id, { onDelete: "cascade" }),
    actor_id: text().notNull(),
    completed_at: bigint({ mode: "number" }).notNull(),
    data: portableJsonb().$type<ActionReceipt>().notNull(),
    receipt_id: text().primaryKey(),
  });
  const killSwitches = schema.table("kill_switches", {
    activated_at: bigint({ mode: "number" }).notNull(),
    agent_id: text().primaryKey(),
    data: portableJsonb().$type<AgentKillSwitch>().notNull(),
  });
  const handoffNonces = schema.table(
    "handoff_nonces",
    {
      expires_at: bigint({ mode: "number" }).notNull(),
      nonce_hash: text().primaryKey(),
    },
    (table) => [index("handoff_nonces_expiry_idx").on(table.expires_at)],
  );
  const delegations = schema.table(
    "delegations",
    {
      data: portableJsonb().$type<AgentDelegation>().notNull(),
      delegation_id: text().primaryKey(),
      expires_at: bigint({ mode: "number" }).notNull(),
      issuer_agent_id: text().notNull(),
      parent_delegation_id: text().references(
        (): AnyPgColumn => delegations.delegation_id,
      ),
      revoked_at: bigint({ mode: "number" }),
      subject_agent_id: text().notNull(),
    },
    (table) => [
      index("delegations_subject_idx").on(
        table.subject_agent_id,
        table.expires_at.desc(),
      ),
      index("delegations_issuer_idx").on(
        table.issuer_agent_id,
        table.expires_at.desc(),
      ),
      index("delegations_parent_idx").on(table.parent_delegation_id),
    ],
  );

  return {
    actions,
    approvals,
    delegations,
    handoffNonces,
    killSwitches,
    leases,
    receipts,
  };
};

export const createDrizzleAgencyStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string } = {},
): AgencyStore => {
  const { actions, approvals, leases, receipts } = agencyDrizzleSchema(
    options.namespace,
  );
  const actorFor = async (actionId: string) => {
    const [row] = await db
      .select({ actorId: actions.actor_id })
      .from(actions)
      .where(eq(actions.action_id, actionId))
      .limit(1);
    if (!row) throw new Error("Unknown action");
    return row.actorId;
  };

  return {
    consumeLease: (leaseId, consumedAt) =>
      db.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ data: leases.data })
          .from(leases)
          .where(and(eq(leases.lease_id, leaseId), isNull(leases.consumed_at)))
          .for("update")
          .limit(1);
        if (!row) return false;
        const updated = await transaction
          .update(leases)
          .set({
            consumed_at: consumedAt,
            data: encodedJsonb({ ...row.data, consumedAt }),
          })
          .where(and(eq(leases.lease_id, leaseId), isNull(leases.consumed_at)))
          .returning({ id: leases.lease_id });
        return updated.length === 1;
      }),
    getAction: async (id) =>
      (
        await db
          .select({ data: actions.data })
          .from(actions)
          .where(eq(actions.action_id, id))
          .limit(1)
      )[0]?.data,
    getApproval: async (id) =>
      (
        await db
          .select({ data: approvals.data })
          .from(approvals)
          .where(eq(approvals.action_id, id))
          .limit(1)
      )[0]?.data,
    getLease: async (id) =>
      (
        await db
          .select({ data: leases.data })
          .from(leases)
          .where(eq(leases.lease_id, id))
          .limit(1)
      )[0]?.data,
    listActions: async (actorId) =>
      (
        await db
          .select({ data: actions.data })
          .from(actions)
          .where(actorId ? eq(actions.actor_id, actorId) : undefined)
          .orderBy(desc(actions.created_at))
      ).map(({ data }) => data),
    listApprovals: async (actorId) =>
      (
        await db
          .select({ data: approvals.data })
          .from(approvals)
          .where(actorId ? eq(approvals.actor_id, actorId) : undefined)
          .orderBy(desc(approvals.approved_at))
      ).map(({ data }) => data),
    listLeases: async (actorId) =>
      (
        await db
          .select({ data: leases.data })
          .from(leases)
          .where(actorId ? eq(leases.actor_id, actorId) : undefined)
          .orderBy(desc(leases.issued_at))
      ).map(({ data }) => data),
    listReceipts: async (actorId) =>
      (
        await db
          .select({ data: receipts.data })
          .from(receipts)
          .where(actorId ? eq(receipts.actor_id, actorId) : undefined)
          .orderBy(desc(receipts.completed_at))
      ).map(({ data }) => data),
    saveAction: async (action) => {
      await db
        .insert(actions)
        .values({
          action_id: action.actionId,
          actor_id: action.actor.agentId,
          created_at: action.createdAt,
          data: encodedJsonb(action),
        })
        .onConflictDoUpdate({
          set: { data: encodedJsonb(action) },
          target: actions.action_id,
        });
    },
    saveApproval: async (approval) =>
      (
        await db
          .insert(approvals)
          .values({
            action_id: approval.actionId,
            actor_id: await actorFor(approval.actionId),
            approved_at: approval.approvedAt,
            data: encodedJsonb(approval),
          })
          .onConflictDoNothing()
          .returning({ id: approvals.action_id })
      ).length === 1,
    saveLease: async (lease) => {
      await db
        .insert(leases)
        .values({
          action_id: lease.actionId,
          actor_id: await actorFor(lease.actionId),
          consumed_at: lease.consumedAt ?? null,
          data: encodedJsonb(lease),
          issued_at: lease.issuedAt,
          lease_id: lease.leaseId,
        })
        .onConflictDoNothing();
    },
    saveReceipt: async (receipt) => {
      await db
        .insert(receipts)
        .values({
          action_id: receipt.actionId,
          actor_id: await actorFor(receipt.actionId),
          completed_at: receipt.completedAt,
          data: encodedJsonb(receipt),
          receipt_id: receipt.receiptId,
        })
        .onConflictDoNothing();
    },
  };
};

export const createDrizzleAgentControlStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string } = {},
): AgentControlStore => {
  const { killSwitches } = agencyDrizzleSchema(options.namespace);
  return {
    clearKillSwitch: async (agentId) => {
      await db.delete(killSwitches).where(eq(killSwitches.agent_id, agentId));
    },
    getKillSwitch: async (agentId) =>
      (
        await db
          .select({ data: killSwitches.data })
          .from(killSwitches)
          .where(eq(killSwitches.agent_id, agentId))
          .limit(1)
      )[0]?.data,
    setKillSwitch: async (killSwitch) => {
      await db
        .insert(killSwitches)
        .values({
          activated_at: killSwitch.activatedAt,
          agent_id: killSwitch.agentId,
          data: encodedJsonb(killSwitch),
        })
        .onConflictDoUpdate({
          set: {
            activated_at: killSwitch.activatedAt,
            data: encodedJsonb(killSwitch),
          },
          target: killSwitches.agent_id,
        });
    },
  };
};

export const createDrizzleHandoffReplayStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string; now?: () => number } = {},
): HandoffReplayStore => {
  const { handoffNonces } = agencyDrizzleSchema(options.namespace);
  const now = options.now ?? Date.now;
  return {
    consume: async (nonce, expiresAt) => {
      if (expiresAt <= now()) return false;
      const rows = await db
        .insert(handoffNonces)
        .values({ expires_at: expiresAt, nonce_hash: await digest(nonce) })
        .onConflictDoNothing()
        .returning({ id: handoffNonces.nonce_hash });
      return rows.length === 1;
    },
  };
};

export const createDrizzleAgentDelegationStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string } = {},
): AgentDelegationStore => {
  const { delegations } = agencyDrizzleSchema(options.namespace);
  return {
    get: async (id) =>
      (
        await db
          .select({ data: delegations.data })
          .from(delegations)
          .where(eq(delegations.delegation_id, id))
          .limit(1)
      )[0]?.data,
    listForAgent: async (agentId) =>
      (
        await db
          .select({ data: delegations.data })
          .from(delegations)
          .where(
            or(
              eq(delegations.issuer_agent_id, agentId),
              eq(delegations.subject_agent_id, agentId),
            ),
          )
          .orderBy(desc(delegations.expires_at))
      ).map(({ data }) => data),
    revokeTree: (id, revokedAt) =>
      db.transaction(async (transaction) => {
        const pending = [id];
        const ids = new Set<string>();
        while (pending.length > 0) {
          const parents = pending.splice(0);
          const rows = await transaction
            .select({
              id: delegations.delegation_id,
              parentId: delegations.parent_delegation_id,
            })
            .from(delegations)
            .where(
              or(
                inArray(delegations.delegation_id, parents),
                inArray(delegations.parent_delegation_id, parents),
              ),
            )
            .for("update");
          for (const row of rows) {
            if (ids.has(row.id)) continue;
            ids.add(row.id);
            if (row.parentId !== null) pending.push(row.id);
          }
        }
        if (ids.size === 0) return 0;
        const active = await transaction
          .select({ data: delegations.data, id: delegations.delegation_id })
          .from(delegations)
          .where(
            and(
              inArray(delegations.delegation_id, [...ids]),
              isNull(delegations.revoked_at),
            ),
          );
        for (const row of active)
          await transaction
            .update(delegations)
            .set({
              data: encodedJsonb({ ...row.data, revokedAt }),
              revoked_at: revokedAt,
            })
            .where(eq(delegations.delegation_id, row.id));
        return active.length;
      }),
    save: async (grant) => {
      const rows = await db
        .insert(delegations)
        .values({
          data: encodedJsonb(grant),
          delegation_id: grant.delegationId,
          expires_at: grant.expiresAt,
          issuer_agent_id: grant.issuerAgentId,
          parent_delegation_id: grant.parentDelegationId ?? null,
          revoked_at: grant.revokedAt ?? null,
          subject_agent_id: grant.subjectAgentId,
        })
        .onConflictDoNothing()
        .returning({ id: delegations.delegation_id });
      if (rows.length !== 1) throw new Error("Delegation already exists");
    },
  };
};
