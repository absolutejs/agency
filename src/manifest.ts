import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { Agency, AgencyOptions } from "./index";

const tool = toolFactory<Agency>();

export const manifest = defineManifest<AgencyOptions, Agency>()({
  contract: 2,
  identity: {
    accent: "#7c3aed",
    category: "auth",
    description:
      "Provider-neutral action authorization for AI agents, including exact-input approval binding, policy re-evaluation, single-use execution leases, signed handoffs, simulation, kill switches, and immutable receipts.",
    docsUrl: "https://github.com/absolutejs/agency",
    name: "@absolutejs/agency",
    tagline: "Control and audit what AI agents may do.",
  },
  settings: Type.Object({
    defaultLeaseTtlMs: Type.Optional(
      Type.Number({
        minimum: 1,
        title: "Execution lease lifetime (milliseconds)",
      }),
    ),
  }),
  tools: {
    inspect_agent_actions: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        effects: ["read"],
        requiredScopes: ["agency:inspect"],
      },
      description:
        "Inspect an agent action ledger including requests, approvals, execution leases, and receipts.",
      handler: async ({ agentId }, agency) =>
        JSON.stringify(await agency.inspect(agentId)),
      input: Type.Object({
        agentId: Type.Optional(Type.String({ minLength: 1 })),
      }),
    }),
  },
  wiring: [
    {
      id: "default",
      server: {
        code: "const agency = createAgency({ defaultLeaseTtlMs: ${settings.defaultLeaseTtlMs} ?? 60000, policy, store: createMemoryAgencyStore() });",
        imports: [
          {
            from: "@absolutejs/agency",
            names: ["createAgency", "createMemoryAgencyStore"],
          },
        ],
        placement: "module-scope",
      },
      title: "Create the agency enforcement point",
    },
  ],
});
