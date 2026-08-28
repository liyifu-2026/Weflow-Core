/**
 * AES-256-GCM SecretBox 单元测试（characterization）：
 * 加解密往返、密文格式、篡改拒绝（fail closed）、错误密钥失败、IV 唯一性。
 */
import { describe, expect, it } from "vitest";
import { makeSecretBox } from "./secret-box.js";

describe("SecretBox (AES-256-GCM)", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const box = makeSecretBox("test-enc-key");
    const samples = [
      "simple-password",
      "带中文与 emoji 😀 的密码",
      'quotes " and \\ backslash',
    ];
    for (const plain of samples) {
      expect(box.decrypt(box.encrypt(plain))).toBe(plain);
    }
  });

  it("stores iv and auth tag before the ciphertext (base64(iv ‖ tag ‖ ct))", () => {
    const box = makeSecretBox("test-enc-key");
    const enc = box.encrypt("secret");
    const data = Buffer.from(enc, "base64");
    // 12 字节 IV + 16 字节 GCM auth tag + 密文（明文 6 字节）
    expect(data.length).toBe(12 + 16 + 6);
    // 解码回明文验证布局：iv/tag 在前，尾部是真实密文
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    expect(
      box.decrypt(Buffer.concat([iv, tag, ciphertext]).toString("base64")),
    ).toBe("secret");
  });

  it("rejects a tampered auth tag (AES-GCM must fail closed)", () => {
    const box = makeSecretBox("test-enc-key");
    const data = Buffer.from(box.encrypt("secret"), "base64");
    data[12] = (data[12] ?? 0) ^ 0xff;
    expect(() => box.decrypt(data.toString("base64"))).toThrow();
  });

  it("rejects a tampered ciphertext body", () => {
    const box = makeSecretBox("test-enc-key");
    const data = Buffer.from(box.encrypt("secret"), "base64");
    const last = data.length - 1;
    data[last] = (data[last] ?? 0) ^ 0x01;
    expect(() => box.decrypt(data.toString("base64"))).toThrow();
  });

  it("fails to decrypt with a different key", () => {
    const enc = makeSecretBox("key-a").encrypt("secret");
    expect(() => makeSecretBox("key-b").decrypt(enc)).toThrow();
  });

  it("uses a unique IV per encryption of the same plaintext", () => {
    const box = makeSecretBox("test-enc-key");
    const first = Buffer.from(box.encrypt("same-input"), "base64").subarray(
      0,
      12,
    );
    const second = Buffer.from(box.encrypt("same-input"), "base64").subarray(
      0,
      12,
    );
    expect(first.equals(second)).toBe(false);
    // 整体密文也必须不同（防重放/模式泄露）
    expect(box.encrypt("same-input")).not.toBe(box.encrypt("same-input"));
  });

  it("round-trips an empty plaintext", () => {
    const box = makeSecretBox("test-enc-key");
    expect(box.decrypt(box.encrypt(""))).toBe("");
  });

  it("rejects inputs shorter than iv+tag+ciphertext", () => {
    const box = makeSecretBox("test-enc-key");
    expect(() => box.decrypt(Buffer.alloc(27).toString("base64"))).toThrow(
      "knora secret box: ciphertext too short",
    );
    expect(() => box.decrypt("not-base64-!!!")).toThrow();
  });
});
