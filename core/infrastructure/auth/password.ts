/**
 * 密码哈希工具
 * 使用 Argon2id 算法进行密码哈希和验证
 * 参数配置：memoryCost=19456, timeCost=2, parallelism=1
 */
import { argon2id, hash, verify, type HashOptions } from "argon2";

/** Argon2id 哈希参数配置 */
const options = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} satisfies HashOptions;

/** 对密码进行哈希处理 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

/** 验证密码是否匹配哈希值 */
export async function verifyPassword(
  encodedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}
