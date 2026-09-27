import { createPublicKey, type KeyObject, sign, verify } from "node:crypto"
import { checkConfigBounds, isTable } from "../config/source.ts"
import { digest } from "../session/files.ts"

export type SignedEnvelope = { version: 1; keyId: string; payload: string; signature: string }
export type SignedPayload = {
  version: 1
  kind: string
  revision: number
  issuedAt: number
  expiresAt: number
}
export function signDocument<T extends SignedPayload>(
  payload: T,
  keyId: string,
  privateKey: KeyObject,
): SignedEnvelope {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Signing requires an Ed25519 key")
  const data = Buffer.from(JSON.stringify(payload))
  return {
    version: 1,
    keyId,
    payload: data.toString("base64"),
    signature: sign(null, data, privateKey).toString("base64"),
  }
}
/** Verify exact signed bytes before parsing. Keys come only from local operator/admin trust roots. */
export function verifyDocument<T extends SignedPayload>(
  raw: unknown,
  kind: string,
  keys: Record<string, string>,
  now = Date.now(),
): { payload: T; fingerprint: string } {
  if (
    !isTable(raw) ||
    raw.version !== 1 ||
    typeof raw.keyId !== "string" ||
    !Object.hasOwn(keys, raw.keyId) ||
    typeof raw.payload !== "string" ||
    raw.payload.length > 2 * 1024 * 1024 ||
    typeof raw.signature !== "string" ||
    raw.signature.length !== 88
  )
    throw new Error("Invalid signed document envelope")
  const data = Buffer.from(raw.payload, "base64"),
    signature = Buffer.from(raw.signature, "base64")
  if (data.toString("base64") !== raw.payload || signature.toString("base64") !== raw.signature)
    throw new Error("Invalid signed document encoding")
  const key = createPublicKey(keys[raw.keyId]!)
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, data, key, signature))
    throw new Error("Signed document verification failed")
  let payload: T
  try {
    payload = JSON.parse(data.toString())
  } catch {
    throw new Error("Invalid signed document payload")
  }
  checkConfigBounds(payload)
  if (
    !isTable(payload) ||
    payload.version !== 1 ||
    payload.kind !== kind ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 1 ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.issuedAt > now + 60000 ||
    payload.expiresAt <= now ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > 366 * 86400000
  )
    throw new Error("Signed document expired or invalid")
  return { payload, fingerprint: digest(data) }
}
export function assertRevision(
  next: { revision: number; fingerprint: string },
  previous?: { revision: number; fingerprint: string },
) {
  if (
    previous &&
    (next.revision < previous.revision ||
      (next.revision === previous.revision && next.fingerprint !== previous.fingerprint))
  )
    throw new Error("Signed document rollback or revision collision refused")
}
