/**
 * AES-256-GCM 加密盒：WeKnora 代管账号的合成密码与令牌加密。
 * 密钥由 KNORA_ACCOUNT_ENC_KEY 经 SHA-256 派生为 32 字节；每次加密使用随机 12 字节 IV。
 * 密文格式：base64(iv ‖ authTag ‖ ciphertext)
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(enc: string): string;
}

export function makeSecretBox(encKey: string): SecretBox {
  const key = createHash("sha256").update(encKey, "utf8").digest();
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plain, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ciphertext]).toString("base64");
    },
    decrypt(enc: string): string {
      const data = Buffer.from(enc, "base64");
      if (data.length < 12 + 16 + 1) {
        throw new Error("knora secret box: ciphertext too short");
      }
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const ciphertext = data.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
