import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { signDocument, verifyDocumentSignature } from "../src/signature.js";
import { sampleManifest } from "./fixtures.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");

function privatePem(): string {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function publicPem(): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

describe("Solution signature", () => {
  it("signs and verifies a canonical document", () => {
    const envelope = signDocument(sampleManifest, {
      keyId: "weflow-release-key",
      privateKeyPem: privatePem(),
    });

    assert.equal(verifyDocumentSignature(sampleManifest, envelope, publicPem()), true);
  });

  it("rejects a tampered document", () => {
    const envelope = signDocument(sampleManifest, {
      keyId: "weflow-release-key",
      privateKeyPem: privatePem(),
    });

    const tampered = {
      ...sampleManifest,
      metadata: {
        ...sampleManifest.metadata,
        version: "1.0.1",
      },
    };

    assert.equal(verifyDocumentSignature(tampered, envelope, publicPem()), false);
  });

  it("rejects a mismatched digest", () => {
    const envelope = signDocument(sampleManifest, {
      keyId: "weflow-release-key",
      privateKeyPem: privatePem(),
    });

    assert.equal(
      verifyDocumentSignature(
        sampleManifest,
        { ...envelope, digest: `sha256:${"0".repeat(64)}` },
        publicPem(),
      ),
      false,
    );
  });

  it("rejects a signature from a different public key", () => {
    const envelope = signDocument(sampleManifest, {
      keyId: "weflow-release-key",
      privateKeyPem: privatePem(),
    });
    const otherPublicPem = otherPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    assert.equal(
      verifyDocumentSignature(sampleManifest, envelope, otherPublicPem),
      false,
    );
  });
});
