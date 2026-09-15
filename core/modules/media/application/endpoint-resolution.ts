/**
 * 媒体执行端点解析策略（模型网关 R2）——从 ingestion-worker 组合根抽出。
 *
 * 识图执行模型分流：主力/视觉槽位分界规则：
 * 1) 主力文本槽位模型带 vision 能力标签 → 直接用主力模型识图，不经过视觉槽位；
 * 2) 否则用视觉槽位绑定的模型（专用视觉小模型兜底）；
 * 3) 网关未绑定启用模型 → undefined（回落 .env 种子端点）。
 *
 * ASR 执行端点分流（配置收敛）：asr 槽位绑定即唯一事实源，端点协议按
 * 注册条目 protocol 分流（chat_inline 内联音频 / audio_transcriptions
 * 标准 multipart）。未绑槽位回落 .env（由调用方按 config.asr / 视觉端点
 * 内联兜底）。网关解析失败 fail-open 回落 legacy 设置，绝不阻断消费。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import * as schema from "../../../infrastructure/postgres/schema.js";
import { resolveSlotChainRuntime } from "../../operations/application/model-gateway.js";

type Database = NodePgDatabase<typeof schema>;

export const resolveVisionEndpoint = async (
  db: Database,
  logger: Logger,
) => {
  try {
    const textChain = await resolveSlotChainRuntime(db, "text");
    if (textChain[0]?.capabilities.includes("vision")) return textChain[0];
    const visionChain = await resolveSlotChainRuntime(db, "vision");
    return visionChain[0];
  } catch (error) {
    logger.warn(
      { err: error },
      "model gateway vision resolution failed; falling back to legacy vision settings",
    );
    return undefined;
  }
};

export const resolveAsrSlotEndpoint = async (
  db: Database,
  logger: Logger,
) => {
  try {
    const asrChain = await resolveSlotChainRuntime(db, "asr");
    return asrChain[0];
  } catch (error) {
    logger.warn(
      { err: error },
      "model gateway asr resolution failed; falling back to legacy asr settings",
    );
    return undefined;
  }
};

/**
 * 语音转码工具链路径：只来自配置（core/.env 的 VOICE_PYTHON_PATH /
 * VOICE_FFMPEG_PATH，weflowctl 启动时注入）；未配置时转码器按
 * PYTHON_PATH / FFMPEG_PATH env 或 PATH 解析，缺失即
 * transcode_unavailable 诚实降级。不设本机绝对路径 fallback。
 */
export function resolveVoiceToolchainPaths(env: NodeJS.ProcessEnv = process.env): {
  pythonPath?: string;
  ffmpegPath?: string;
} {
  const pythonPath = env.VOICE_PYTHON_PATH?.trim() || undefined;
  const ffmpegPath = env.VOICE_FFMPEG_PATH?.trim() || undefined;
  return {
    ...(pythonPath ? { pythonPath } : {}),
    ...(ffmpegPath ? { ffmpegPath } : {}),
  };
}
