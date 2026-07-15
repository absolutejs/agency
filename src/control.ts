export type AgentControlItem = {
  expiresAt?: number;
  id: string;
  kind: string;
  metadata?: Record<string, unknown>;
  source: string;
  status: "active" | "pending" | "revoked" | "used";
};

export type AgentControlSource = {
  inventory: (agentId: string) => Promise<ReadonlyArray<AgentControlItem>>;
  name: string;
  revoke: (agentId: string, reason: string) => Promise<number>;
};

export type AgentKillSwitch = {
  activatedAt: number;
  activatedBy: string;
  agentId: string;
  reason: string;
};

export type AgentControlStore = {
  clearKillSwitch: (agentId: string) => Promise<void>;
  getKillSwitch: (agentId: string) => Promise<AgentKillSwitch | undefined>;
  setKillSwitch: (killSwitch: AgentKillSwitch) => Promise<void>;
};

export const createMemoryAgentControlStore = (): AgentControlStore => {
  const switches = new Map<string, AgentKillSwitch>();

  return {
    clearKillSwitch: async (agentId) => {
      switches.delete(agentId);
    },
    getKillSwitch: async (agentId) => switches.get(agentId),
    setKillSwitch: async (killSwitch) => {
      switches.set(killSwitch.agentId, structuredClone(killSwitch));
    },
  };
};

export const createAgentControlPlane = ({
  now = Date.now,
  sources,
  store,
}: {
  now?: () => number;
  sources: ReadonlyArray<AgentControlSource>;
  store: AgentControlStore;
}) => {
  const status = async (agentId: string) => store.getKillSwitch(agentId);

  const assertActive = async (agentId: string) => {
    const killSwitch = await status(agentId);
    if (killSwitch !== undefined)
      throw new Error(`Agent is disabled: ${killSwitch.reason}`);
  };

  const inventory = async (agentId: string) => {
    const settled = await Promise.allSettled(
      sources.map(async (source) => ({
        items: await source.inventory(agentId),
        source: source.name,
      })),
    );
    return {
      agentId,
      items: settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value.items : [],
      ),
      killSwitch: await status(agentId),
      sourceErrors: settled.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              {
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : "Control source failed",
                source: sources[index]?.name ?? "unknown",
              },
            ]
          : [],
      ),
    };
  };

  const revoke = async ({
    activatedBy,
    agentId,
    reason,
  }: {
    activatedBy: string;
    agentId: string;
    reason: string;
  }) => {
    const killSwitch: AgentKillSwitch = {
      activatedAt: now(),
      activatedBy,
      agentId,
      reason,
    };
    // Fail closed immediately. Downstream cleanup may take longer or fail.
    await store.setKillSwitch(killSwitch);
    const settled = await Promise.allSettled(
      sources.map(async (source) => ({
        revoked: await source.revoke(agentId, reason),
        source: source.name,
      })),
    );

    return {
      killSwitch,
      results: settled.map((result, index) =>
        result.status === "fulfilled"
          ? { ...result.value, status: "fulfilled" as const }
          : {
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : "Control source failed",
              source: sources[index]?.name ?? "unknown",
              status: "rejected" as const,
            },
      ),
    };
  };

  return {
    assertActive,
    inventory,
    restore: store.clearKillSwitch,
    revoke,
    status,
  };
};

export type AgentControlPlane = ReturnType<typeof createAgentControlPlane>;
