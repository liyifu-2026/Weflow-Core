/**
 * WeKnora 桥接账号服务：weflow 用户 → WeKnora 用户的代管登录。
 *
 * - 新 weflow 用户：自动注册 WeKnora 账号（合成密码）+ 加入共享租户
 * - 已存在的 WeKnora 账号（如部署初期手工创建的 leaif@weflow.com）：
 *   注册会因邮箱冲突失败，由一次性 bootstrap（用户输入一次该账号密码）完成绑定
 * - 访问/刷新令牌与合成密码以 AES-256-GCM 密文存 knora_accounts，
 *   缓存 22h 内直接复用，过期后用合成密码重新登录
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import type { AuthenticatedUser } from "../../identity/application/identity-service.js";
import {
  knoraAddMember,
  knoraLogin,
  knoraRegister,
  type KnoraLoginResponse,
  type KnoraUpstream,
} from "./knora-http.js";
import type { SecretBox } from "./secret-box.js";

const CACHE_TTL_MS = 22 * 60 * 60 * 1_000; // 访问令牌 24h，留 2h 余量

export class KnoraBootstrapRequiredError extends Error {
  constructor(
    message: string,
    public readonly expectedEmail: string,
  ) {
    super(message);
    this.name = "KnoraBootstrapRequiredError";
  }
}

/** 交换端点返回给 bridge 页的载荷（字段名对齐 WeKnora 登录响应） */
export type KnoraSessionPayload = {
  token: string;
  refresh_token: string;
  user: unknown;
  active_tenant: unknown;
  memberships: unknown[];
  selected_tenant_id: string;
  selected_tenant_name: string;
};

export class KnoraAccountService {
  constructor(
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly upstream: KnoraUpstream,
    private readonly box: SecretBox,
    private readonly tenantId: number,
    private readonly emailDomain: string,
  ) {}

  /** 邮箱域名一致的前提下，weflow 用户名 → 邮箱本地部分（非 ASCII 用户名退化为稳定哈希） */
  emailFor(username: string): string {
    const local = username.trim().toLowerCase();
    return /^[a-z0-9._-]+$/.test(local)
      ? `${local}@${this.emailDomain}`
      : `u${createHash("sha256").update(username).digest("hex").slice(0, 16)}@${this.emailDomain}`;
  }

  /** weflow 角色 → 共享租户内的 WeKnora 角色 */
  private roleFor(user: AuthenticatedUser): string {
    return user.role === "admin" ? "admin" : "contributor";
  }

  /**
   * 确保桥接账号存在并返回可交给浏览器的会话载荷。
   * 注册冲突（邮箱已存在）时抛 KnoraBootstrapRequiredError，由调用方引导一次性绑定。
   */
  async sessionFor(user: AuthenticatedUser): Promise<KnoraSessionPayload> {
    const [account] = await this.db
      .select()
      .from(schema.knoraAccounts)
      .where(eq(schema.knoraAccounts.weflowUserId, user.userId))
      .limit(1);

    let tokens: KnoraLoginResponse;
    let email: string;
    if (account) {
      email = account.knoraEmail;
      const cached =
        account.accessTokenEnc && account.tokensExpireAt
          ? {
              token: this.box.decrypt(account.accessTokenEnc),
              refresh_token: account.refreshTokenEnc
                ? this.box.decrypt(account.refreshTokenEnc)
                : "",
            }
          : null;
      if (
        cached &&
        account.tokensExpireAt &&
        account.tokensExpireAt.getTime() > Date.now()
      ) {
        tokens = {
          token: cached.token,
          refresh_token: cached.refresh_token,
          user: null,
          active_tenant: null,
          memberships: [],
        };
      } else {
        // 缓存过期：用合成密码重新登录并回填
        tokens = await knoraLogin(this.upstream, {
          email,
          password: this.box.decrypt(account.passwordEnc),
        });
        await this.persistTokens(account.weflowUserId, tokens);
      }
    } else {
      email = this.emailFor(user.username);
      const password = randomBytes(18).toString("base64url");
      try {
        await knoraRegister(this.upstream, {
          username: user.username,
          email,
          password,
        });
      } catch {
        // 邮箱已存在：账号是手工创建的（或历史数据），需要一次性绑定
        throw new KnoraBootstrapRequiredError(
          `WeKnora 账号 ${email} 已存在，需要绑定`,
          email,
        );
      }
      tokens = await knoraLogin(this.upstream, { email, password });
      await this.persistAccount(user, email, password, tokens);
    }

    // 每次启动都补一次共享租户成员关系（幂等；已存在会返回业务错误，忽略）。
    // 这样首次加入失败也能在下一次启动时自愈。
    try {
      await knoraAddMember(this.upstream, {
        tenantId: this.tenantId,
        email,
        role: this.roleFor(user),
      });
    } catch {
      // 已是成员 / 权限受限等业务错误：不影响会话
    }

    return this.buildPayload(tokens);
  }

  /** 一次性绑定：用户输入一次已存在的 WeKnora 账号密码，换取代管凭证 */
  async bootstrap(
    user: AuthenticatedUser,
    password: string,
  ): Promise<KnoraSessionPayload> {
    const email = this.emailFor(user.username);
    const tokens = await knoraLogin(this.upstream, { email, password });
    await this.persistAccount(user, email, password, tokens);
    return this.buildPayload(tokens);
  }

  private async persistAccount(
    user: AuthenticatedUser,
    email: string,
    password: string,
    tokens: KnoraLoginResponse,
  ): Promise<void> {
    const knoraUserId =
      (tokens.user as { id?: string } | null)?.id ??
      this.userIdFromToken(tokens.token);
    await this.db
      .insert(schema.knoraAccounts)
      .values({
        weflowUserId: user.userId,
        knoraUserId: knoraUserId || "unknown",
        knoraEmail: email,
        passwordEnc: this.box.encrypt(password),
        accessTokenEnc: this.box.encrypt(tokens.token),
        refreshTokenEnc: this.box.encrypt(tokens.refresh_token),
        tokensExpireAt: new Date(Date.now() + CACHE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: schema.knoraAccounts.weflowUserId,
        set: {
          knoraEmail: email,
          knoraUserId: knoraUserId || "unknown",
          passwordEnc: this.box.encrypt(password),
          accessTokenEnc: this.box.encrypt(tokens.token),
          refreshTokenEnc: this.box.encrypt(tokens.refresh_token),
          tokensExpireAt: new Date(Date.now() + CACHE_TTL_MS),
          updatedAt: new Date(),
        },
      });
  }

  private async persistTokens(
    weflowUserId: string,
    tokens: KnoraLoginResponse,
  ): Promise<void> {
    await this.db
      .update(schema.knoraAccounts)
      .set({
        accessTokenEnc: this.box.encrypt(tokens.token),
        refreshTokenEnc: this.box.encrypt(tokens.refresh_token),
        tokensExpireAt: new Date(Date.now() + CACHE_TTL_MS),
        updatedAt: new Date(),
      })
      .where(eq(schema.knoraAccounts.weflowUserId, weflowUserId));
  }

  /** 用访问令牌换取 UI 需要的完整载荷（user/active_tenant/memberships 走 /me 保证形状正确） */
  private async buildPayload(
    tokens: KnoraLoginResponse,
  ): Promise<KnoraSessionPayload> {
    const me = await this.meWithActiveTenant(tokens.token);
    const tenant = me?.tenant;
    const tenantName =
      (tenant as { name?: string } | undefined)?.name ?? "Workspace";
    return {
      token: tokens.token,
      refresh_token: tokens.refresh_token,
      user: me?.user ?? tokens.user,
      active_tenant: tenant,
      memberships: me?.memberships ?? tokens.memberships,
      selected_tenant_id: String(this.tenantId),
      selected_tenant_name: tenantName,
    };
  }

  private async meWithActiveTenant(bearer: string): Promise<{
    user?: unknown;
    tenant?: unknown;
    memberships?: unknown[];
  } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, this.upstream.timeoutMs);
      const response = await fetch(`${this.upstream.baseUrl}/auth/me`, {
        headers: {
          authorization: `Bearer ${bearer}`,
          "x-tenant-id": String(this.tenantId),
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) return null;
      const body = (await response.json()) as {
        data?: { user?: unknown; tenant?: unknown; memberships?: unknown[] };
      };
      return {
        user: body.data?.user,
        tenant: body.data?.tenant,
        ...(body.data?.memberships !== undefined
          ? { memberships: body.data.memberships }
          : {}),
      };
    } catch {
      return null;
    }
  }

  /** 从 JWT payload 解出 user_id（登录响应的 user 缺 id 时兜底） */
  private userIdFromToken(token: string): string | null {
    try {
      const payload = token.split(".")[1];
      if (!payload) return null;
      const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { user_id?: string };
      return claims.user_id ?? null;
    } catch {
      return null;
    }
  }
}
