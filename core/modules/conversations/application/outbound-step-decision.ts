/**
 * 出站单条消息的纯决策核：从 processOutboundMessages 循环体抽出的
 * 无 I/O 判定规则。循环保持 I/O 外壳；分段阻塞 / 打字节拍 / kill-switch
 * 扣留等规则在此表驱动可测（此前只能靠重建 DB fixture 的集成测试覆盖）。
 */
import { createHash } from "node:crypto";
import { SEND_STATE } from "./send-states.js";

/** 打字节拍（真人化分段间隔）：同批次第 2 段起，距离上一段发出至少
 * 等待"打字时间"——固定切换开销 + 按字数线性增长的输入时间 + 以
 * messageId 为种子的确定性抖动。确定性保证轮询重查结果稳定、可测试。
 * 机制对渠道中立（同既有出站节流）；参数为出厂默认，后续可提升为设置。 */
const TYPING_BASE_MS = 900;
const TYPING_MS_PER_CHAR = 280;
const TYPING_MAX_MS = 6_500;
const TYPING_JITTER_SPAN_MS = 1_400;

export function interSegmentDelayMs(
  text: string,
  seedMessageId: string,
): number {
  const chars = Math.min(Array.from(text.trim()).length, 60);
  const typing = TYPING_BASE_MS + TYPING_MS_PER_CHAR * chars;
  const seed = createHash("sha256").update(seedMessageId).digest()[0] ?? 0;
  const jitter =
    (seed / 255) * TYPING_JITTER_SPAN_MS - TYPING_JITTER_SPAN_MS / 2;
  return Math.round(
    Math.min(Math.max(typing + jitter, 600), TYPING_MAX_MS + 700),
  );
}

/** 前序分段闸门判定输入（由循环预查询装配，本模块不做 I/O）。 */
export type PriorSegmentGateInput = {
  /** 存在前序分段仍 pending/submitting */
  hasUnsentPrior: boolean;
  /** 事件同步已产生 delivered 副本（前序分段实际已送达渠道） */
  deliveredCopyExists: boolean;
  /** 前序分段发出时间（打字节拍基准）；无前序分段为 null */
  priorSentAt: Date | null;
  text: string;
  messageId: string;
  now: Date;
};

export type PriorSegmentGateVerdict = "blocked" | "pacing" | "ok";

/**
 * 前序分段闸门：
 * - blocked：前序分段仍未发出且无 delivered 副本 → 本段不得越过；
 * - pacing ：前序已发出但打字节拍未到 → 本段本轮跳过；
 * - ok     ：可以发送。
 * 即使乐观行仍 pending/submitting，若已产生 delivered 副本（消息实际
 * 已送达渠道），后续分段不应被永久阻塞——delivered 副本解除 blocked。
 */
export function priorSegmentGate(
  input: PriorSegmentGateInput,
): PriorSegmentGateVerdict {
  if (input.hasUnsentPrior && !input.deliveredCopyExists) return "blocked";
  if (input.priorSentAt) {
    const elapsed = input.now.getTime() - input.priorSentAt.getTime();
    const delay = interSegmentDelayMs(input.text, input.messageId);
    if (elapsed < delay) return "pacing";
  }
  return "ok";
}

/**
 * AI Kill Switch 硬门（代码级）：agent 消息在 auto_send_enabled OFF 时
 * 绝对禁止发送 → 置 held（终态，恢复开关后不自动补发）；human/system
 * （含程序化 handoff 确认语）永远允许；unknown 不扣留（无法安全对账）。
 */
export function shouldHoldForKillSwitch(input: {
  actorType: string;
  sendState: string | null;
  autoSendEnabled: boolean;
}): boolean {
  return (
    input.actorType === "agent" &&
    input.sendState !== SEND_STATE.unknown &&
    !input.autoSendEnabled
  );
}

// ── 发送期插话闸门（pre-send interjection gate）────────────────────

/** 插话闸门判定输入（由出站循环装配；本模块不做 I/O）。 */
export type InterjectionGateInput = {
  /** runtime 开关 outbound_interject_gate_enabled */
  gateEnabled: boolean;
  chatType: "private" | "group";
  /** agent 回复批次（actorType==='agent' 且 replyBatchId 以 agent-reply: 开头） */
  isAgentReplyBatch: boolean;
  /** tool-result 变体：携带不可再生的工具结论，照发（对齐吸收矩阵 carry-through） */
  isToolResultVariant: boolean;
  /**
   * 触发消息发送者（turn:{messageId} 解析后查得）；群聊「原提问者」判定
   * 基准。wake 轮（turn:wake:*）与解析失败为 null → 群聊不扣。
   */
  triggerActorId: string | null;
  /**
   * 批次落库后的新入站（锚点 = 分段自身 createdAt：吸收机制保证落库前
   * 插话已并入最终决策，落库后的才算未处理插话）。
   */
  interjections: readonly { actorId: string | null }[];
};

export type InterjectionGateVerdict = "send" | "hold";

/**
 * 发送期插话闸门：每段发送前判定世界变了没有。
 * - send：照常发送（开关关 / 非 agent 批次 / tool-result 豁免 / 未命中插话）；
 * - hold：扣留本段及剩余分段（置 held + reply_interrupted 事件），
 *   由插话消息自然触发的新 turn 在含被扣留分段的上下文上重新决策。
 * 群聊只有「原提问者的新消息」才扣——路人闲聊不扣，否则嘈杂群回复
 * 永远发不完；私聊任何新入站都扣。
 */
export function interjectionGate(
  input: InterjectionGateInput,
): InterjectionGateVerdict {
  if (!input.gateEnabled) return "send";
  if (!input.isAgentReplyBatch) return "send";
  if (input.isToolResultVariant) return "send";
  if (input.interjections.length === 0) return "send";
  if (input.chatType === "private") return "hold";
  // 群聊：仅原提问者插话才扣；wake 轮无触发者基准，保守不扣。
  if (input.triggerActorId === null) return "send";
  const sameActor = input.interjections.some(
    (interjection) => interjection.actorId === input.triggerActorId,
  );
  return sameActor ? "hold" : "send";
}
