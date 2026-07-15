import { canonicalJson } from "./canonical";
import type { Money } from "./types";

export type AgentHandoffClaims = {
  action: string;
  audience: string;
  delegationId: string;
  expiresAt: number;
  handoffId: string;
  inputDigest: string;
  issuedAt: number;
  issuerAgentId: string;
  nonce: string;
  parentActionId?: string;
  scopes: ReadonlyArray<string>;
  spendLimit?: Money;
  subjectAgentId: string;
  userId: string;
  version: "absolute.agent-handoff/1";
};

export type SignedAgentHandoff = {
  algorithm: "HS256";
  claims: AgentHandoffClaims;
  keyId: string;
  signature: string;
};

export type HandoffReplayStore = {
  consume: (nonce: string, expiresAt: number) => Promise<boolean>;
};

const encode = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const keyBytes = (key: string | Uint8Array) =>
  typeof key === "string" ? new TextEncoder().encode(key) : key;

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const sign = async (
  claims: AgentHandoffClaims,
  keyId: string,
  key: string | Uint8Array,
) => {
  const rawKey = Uint8Array.from(keyBytes(key));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey.buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return encode(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(canonicalJson({ claims, keyId })),
    ),
  );
};

export const signAgentHandoff = async ({
  claims,
  key,
  keyId,
}: {
  claims: Omit<AgentHandoffClaims, "version">;
  key: string | Uint8Array;
  keyId: string;
}): Promise<SignedAgentHandoff> => {
  const versioned: AgentHandoffClaims = {
    ...claims,
    version: "absolute.agent-handoff/1",
  };
  return {
    algorithm: "HS256",
    claims: versioned,
    keyId,
    signature: await sign(versioned, keyId, key),
  };
};

export const verifyAgentHandoff = async ({
  expectedAudience,
  handoff,
  key,
  now = Date.now,
  replayStore,
}: {
  expectedAudience: string;
  handoff: SignedAgentHandoff;
  key: string | Uint8Array;
  now?: () => number;
  replayStore: HandoffReplayStore;
}) => {
  if (handoff.algorithm !== "HS256")
    throw new Error("Unsupported handoff algorithm");
  if (handoff.claims.version !== "absolute.agent-handoff/1")
    throw new Error("Unsupported handoff version");
  if (handoff.claims.audience !== expectedAudience)
    throw new Error("Agent handoff audience mismatch");
  if (handoff.claims.expiresAt <= now())
    throw new Error("Agent handoff has expired");
  const expected = await sign(handoff.claims, handoff.keyId, key);
  const actualBytes = new TextEncoder().encode(handoff.signature);
  const expectedBytes = new TextEncoder().encode(expected);
  if (!constantTimeEqual(actualBytes, expectedBytes))
    throw new Error("Invalid agent handoff signature");
  if (
    !(await replayStore.consume(handoff.claims.nonce, handoff.claims.expiresAt))
  )
    throw new Error("Agent handoff has already been consumed");

  return structuredClone(handoff.claims);
};

export const createMemoryHandoffReplayStore = (
  now: () => number = Date.now,
): HandoffReplayStore => {
  const nonces = new Map<string, number>();
  return {
    consume: async (nonce, expiresAt) => {
      for (const [storedNonce, expiry] of nonces)
        if (expiry <= now()) nonces.delete(storedNonce);
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, expiresAt);
      return true;
    },
  };
};

export const attenuateAgentHandoff = (
  parent: AgentHandoffClaims,
  child: Omit<AgentHandoffClaims, "version">,
) => {
  if (child.userId !== parent.userId)
    throw new Error("Agent handoff cannot change users");
  if (child.expiresAt > parent.expiresAt)
    throw new Error("Agent handoff cannot extend expiry");
  if (child.scopes.some((scope) => !parent.scopes.includes(scope)))
    throw new Error("Agent handoff cannot escalate scopes");
  if (parent.spendLimit !== undefined) {
    if (
      child.spendLimit === undefined ||
      child.spendLimit.currency !== parent.spendLimit.currency ||
      child.spendLimit.amountMinor > parent.spendLimit.amountMinor
    )
      throw new Error("Agent handoff cannot escalate spend");
  }

  return child;
};
