/**
 * service domain：把 api / agent-worker / ingestion-worker 包装为 Windows 服务。
 *
 * 实现走 WinSW2（单 exe + XML 配置，MIT）：一个通用 `weflow-service.exe`
 * 复制三份，各配一份 XML 指向 core dist 的 node 入口。相比 sc.exe 原生
 * 包装，WinSW 提供日志重定向、崩溃自动重启与 <onfailure> 语义。
 *
 * Channel Host（微信）不服务化：它依赖已登录的微信桌面窗口（交互式
 * UIA），必须在登录用户的桌面会话中运行（见部署文档）。
 *
 * XML 生成等服务定义逻辑是纯函数（可单测）；Windows 执行（sc 命令、
 * 文件落盘）集中在 service-runtime。
 */

/** 服务定义键：与 dev 域 serviceDefinitions 的 key 保持一致 */
export const SERVICE_KEYS = ["core-api", "agent-worker", "ingestion-worker"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

const SERVICE_DISPLAY = "Weflow %s";
const SERVICE_DESCRIPTION =
  "Weflow AI 客服平台进程（api / agent-worker / ingestion-worker 之一）。由 weflowctl service 安装管理。";

/** WinSW 通用可执行文件名（tools/winsw/ 下，复制为 <service>.exe 生效） */
export const WINSW_HOST_EXE = "weflow-service.exe";

/** 部署根目录布局约定（与部署文档一致） */
export function serviceNames(key: ServiceKey): { serviceName: string; display: string } {
  return {
    serviceName: `weflow-${key}`,
    display: SERVICE_DISPLAY.replace("%s", key),
  };
}

export interface ServiceFilePlan {
  /** WinSW host exe 的文件名（服务 exe 必须与 XML 同名同名目录） */
  exeName: string;
  /** XML 配置文件名 */
  xmlName: string;
  /** XML 内容 */
  xml: string;
}

/**
 * 生成单个服务的 WinSW XML 配置。
 * @param coreDir  core 目录绝对路径（含 dist/ 与 node_modules/）
 * @param nodeExe  node.exe 绝对路径
 * @param key      服务键
 * @param logDir   日志目录（WinSW rotate 模式）
 */
export function renderWinswXml(
  coreDir: string,
  nodeExe: string,
  key: ServiceKey,
  logDir: string,
): string {
  const { serviceName, display } = serviceNames(key);
  const entry = {
    "core-api": "dist/apps/api/main.js",
    "agent-worker": "dist/apps/agent-worker/main.js",
    "ingestion-worker": "dist/apps/ingestion-worker/main.js",
  }[key];
  return `<!--
  Weflow ${key} Windows 服务配置（WinSW）。
  由 weflowctl service install 生成；重装前修改不会保留。
-->
<service>
  <id>${serviceName}</id>
  <name>${display}</name>
  <description>${SERVICE_DESCRIPTION}</description>
  <executable>${xmlEscape(nodeExe)}</executable>
  <arguments>--env-file=.env ${xmlEscape(entry)}</arguments>
  <workingdirectory>${xmlEscape(coreDir)}</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="none"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <stopparentprocessfirst>false</stopparentprocessfirst>
  <log mode="roll-by-size">
    <logpath>${xmlEscape(logDir)}</logpath>
    <logmode>roll</logmode>
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <env name="NODE_ENV" value="production"/>
</service>
`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** service 域用法 */
export const SERVICE_USAGE = [
  "service  Windows 服务管理（api / agent-worker / ingestion-worker）",
  "         fetch-host  下载 WinSW host exe（weflow-service.exe，需联网一次）",
  "         install    安装三个服务（生成 WinSW 配置，需要管理员终端）",
  "         uninstall  卸载三个服务",
  "         start      启动三个服务",
  "         stop       停止三个服务",
  "         restart    重启三个服务（热更新规程使用）",
  "         status     查询三个服务的 Windows 状态",
  "",
  "说明：Channel Host（微信）不服务化，需登录用户桌面会话运行；",
  "      服务化前必须先完成 core 构建（pnpm build）与 .env 生产配置。",
].join("\n");

export type ServiceCommandResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: string; hint?: string };

/** 服务状态行 */
export interface ServiceStatusRow {
  service: string;
  state: string;
  detail: string;
}
