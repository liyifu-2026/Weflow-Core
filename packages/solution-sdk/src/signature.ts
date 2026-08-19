import { sign, verify } from "node:crypto";
import { canonicalStringify, sha256Hex } from "./canonical.js";
import type { SolutionSignature } from "./types.js";

export interface SignDocumentOptions {
  keyId: string;
  privateKeyPem: string;
}

/**
 * 对文档的规范化字节做 Ed25519 签名。
 * 签名信封携带文档 digest，验证方先核对 digest 再验签。
 */
export function signDocument(
  document: unknown,
  options: SignDocumentOptions,
): SolutionSignature {
  const canonical = canonicalStringify(document);
  const digest = `sha256:${sha256Hex(canonical)}`;
  const signature = sign(
    null,
    Buffer.from(canonical, "utf8"),
    options.privateKeyPem,
  ).toString("base64");
  return {
    algorithm: "ed25519",
    keyId: options.keyId,
    digest,
    signature,
  };
}

export function verifyDocumentSignature(
  document: unknown,
  envelope: SolutionSignature,
  publicKeyPem: string,
): boolean {
  if (envelope.algorithm !== "ed25519") return false;
  const canonical = canonicalStringify(document);
  const digest = `sha256:${sha256Hex(canonical)}`;
  if (digest !== envelope.digest) return false;
  try {
    return verify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKeyPem,
      Buffer.from(envelope.signature, "base64"),
    );
  } catch {
    return false;
  }
}
