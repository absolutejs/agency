import type { ActionRequestInput, Money } from "./types";

export type AgentDelegation = {
  audience: string;
  delegationId: string;
  depth: number;
  effects: ReadonlyArray<string>;
  expiresAt: number;
  issuedAt: number;
  issuerAgentId: string;
  parentDelegationId?: string;
  resourceIds?: ReadonlyArray<string>;
  resourceTypes: ReadonlyArray<string>;
  revokedAt?: number;
  scopes: ReadonlyArray<string>;
  spendLimit?: Money;
  subjectAgentId: string;
  userId: string;
};

export type AgentDelegationStore = {
  get: (delegationId: string) => Promise<AgentDelegation | undefined>;
  listForAgent: (agentId: string) => Promise<ReadonlyArray<AgentDelegation>>;
  revokeTree: (delegationId: string, revokedAt: number) => Promise<number>;
  save: (delegation: AgentDelegation) => Promise<void>;
};

export type AgentDelegationInput = Omit<
  AgentDelegation,
  "delegationId" | "depth" | "issuedAt" | "revokedAt"
>;

const clone = <Value>(value: Value): Value => structuredClone(value);

export const createMemoryAgentDelegationStore = (): AgentDelegationStore => {
  const grants = new Map<string, AgentDelegation>();
  return {
    get: async (id) => {
      const grant = grants.get(id);
      return grant ? clone(grant) : undefined;
    },
    listForAgent: async (agentId) =>
      [...grants.values()]
        .filter(
          (grant) =>
            grant.subjectAgentId === agentId || grant.issuerAgentId === agentId,
        )
        .map(clone),
    revokeTree: async (rootId, revokedAt) => {
      const pending = [rootId];
      let count = 0;
      while (pending.length > 0) {
        const id = pending.shift()!;
        const grant = grants.get(id);
        if (!grant) continue;
        if (!grant.revokedAt) {
          grant.revokedAt = revokedAt;
          count += 1;
        }
        for (const child of grants.values())
          if (child.parentDelegationId === id) pending.push(child.delegationId);
      }
      return count;
    },
    save: async (grant) => {
      if (grants.has(grant.delegationId))
        throw new Error("Delegation already exists");
      grants.set(grant.delegationId, clone(grant));
    },
  };
};

const subset = (child: ReadonlyArray<string>, parent: ReadonlyArray<string>) =>
  child.every((value) => parent.includes(value));

const validMoney = (money: Money | undefined) =>
  money === undefined ||
  (Number.isSafeInteger(money.amountMinor) &&
    money.amountMinor >= 0 &&
    /^[A-Z]{3}$/u.test(money.currency));

const validate = (grant: AgentDelegationInput) => {
  if (
    !grant.audience ||
    !grant.issuerAgentId ||
    !grant.subjectAgentId ||
    !grant.userId ||
    grant.scopes.length === 0 ||
    grant.effects.length === 0 ||
    grant.resourceTypes.length === 0
  )
    throw new Error("Delegation is missing required boundaries");
  if (!validMoney(grant.spendLimit))
    throw new Error("Invalid delegation spend limit");
};

export const createAgentDelegationAuthority = (options: {
  audience: string;
  maxDepth?: number;
  now?: () => number;
  store: AgentDelegationStore;
}) => {
  const now = options.now ?? Date.now;
  const issue = async (input: AgentDelegationInput) => {
    validate(input);
    const issuedAt = now();
    if (input.parentDelegationId)
      throw new Error("Use delegate() to issue a child delegation");
    if (input.audience !== options.audience)
      throw new Error("Delegation audience mismatch");
    if (input.expiresAt <= issuedAt)
      throw new Error("Delegation must expire in the future");
    const grant: AgentDelegation = {
      ...clone(input),
      delegationId: `dlg_${crypto.randomUUID()}`,
      depth: 0,
      issuedAt,
    };
    await options.store.save(grant);
    return clone(grant);
  };

  const delegate = async (
    parentDelegationId: string,
    input: Omit<AgentDelegationInput, "parentDelegationId">,
  ) => {
    validate(input);
    const parent = await options.store.get(parentDelegationId);
    if (!parent) throw new Error("Unknown parent delegation");
    const current = now();
    if (parent.revokedAt || parent.expiresAt <= current)
      throw new Error("Parent delegation is inactive");
    if (parent.depth + 1 > (options.maxDepth ?? 8))
      throw new Error("Delegation depth exceeded");
    if (
      input.issuerAgentId !== parent.subjectAgentId ||
      input.userId !== parent.userId ||
      input.audience !== parent.audience
    )
      throw new Error("Child delegation changed identity or audience");
    if (
      input.expiresAt > parent.expiresAt ||
      !subset(input.scopes, parent.scopes) ||
      !subset(input.effects, parent.effects) ||
      !subset(input.resourceTypes, parent.resourceTypes) ||
      (parent.resourceIds &&
        (!input.resourceIds || !subset(input.resourceIds, parent.resourceIds)))
    )
      throw new Error("Child delegation escalates parent authority");
    if (parent.spendLimit) {
      if (
        !input.spendLimit ||
        input.spendLimit.currency !== parent.spendLimit.currency ||
        input.spendLimit.amountMinor > parent.spendLimit.amountMinor
      )
        throw new Error("Child delegation escalates spend");
    }
    const grant: AgentDelegation = {
      ...clone(input),
      delegationId: `dlg_${crypto.randomUUID()}`,
      depth: parent.depth + 1,
      issuedAt: current,
      parentDelegationId,
    };
    await options.store.save(grant);
    return clone(grant);
  };

  const getActiveChain = async (delegationId: string) => {
    const chain: AgentDelegation[] = [];
    const seen = new Set<string>();
    let id: string | undefined = delegationId;
    while (id) {
      if (seen.has(id)) throw new Error("Delegation chain contains a cycle");
      seen.add(id);
      const grant = await options.store.get(id);
      if (!grant) throw new Error("Unknown delegation");
      if (grant.revokedAt || grant.expiresAt <= now())
        throw new Error("Delegation is inactive");
      chain.push(grant);
      id = grant.parentDelegationId;
    }
    return chain;
  };

  const assertAllows = async (action: ActionRequestInput) => {
    if (!action.actor.delegationId) return {};
    const chain = await getActiveChain(action.actor.delegationId);
    const grant = chain[0]!;
    if (
      grant.audience !== options.audience ||
      grant.subjectAgentId !== action.actor.agentId ||
      grant.userId !== action.actor.userId ||
      !subset(action.actor.scopes, grant.scopes)
    )
      throw new Error("Delegation actor or audience mismatch");
    if (!grant.scopes.includes(action.action))
      throw new Error("Action is outside delegated scope");
    if (!action.effects.every((effect) => grant.effects.includes(effect)))
      throw new Error("Action effect is outside delegation");
    if (!grant.resourceTypes.includes(action.resource.type))
      throw new Error("Resource type is outside delegation");
    if (grant.resourceIds && !grant.resourceIds.includes(action.resource.id))
      throw new Error("Resource is outside delegation");
    if (action.spend) {
      if (
        !validMoney(action.spend) ||
        !grant.spendLimit ||
        action.spend.currency !== grant.spendLimit.currency ||
        action.spend.amountMinor > grant.spendLimit.amountMinor
      )
        throw new Error("Spend is outside delegation");
    }
    return { expiresAt: Math.min(...chain.map(({ expiresAt }) => expiresAt)) };
  };

  return {
    assertAllows,
    delegate,
    issue,
    listForAgent: options.store.listForAgent,
    revoke: (delegationId: string) =>
      options.store.revokeTree(delegationId, now()),
  };
};
