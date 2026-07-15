const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }

  return value;
};

export const canonicalJson = (value: unknown) =>
  JSON.stringify(normalize(value));

export const digest = async (value: unknown) => {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const result = await crypto.subtle.digest("SHA-256", encoded);

  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const actionBinding = (action: {
  action: string;
  actionId: string;
  actor: unknown;
  effects: unknown;
  expiresAt?: number;
  inputDigest: string;
  resource: unknown;
  spend?: unknown;
}) =>
  digest({
    action: action.action,
    actionId: action.actionId,
    actor: action.actor,
    effects: action.effects,
    expiresAt: action.expiresAt,
    inputDigest: action.inputDigest,
    resource: action.resource,
    spend: action.spend,
  });
