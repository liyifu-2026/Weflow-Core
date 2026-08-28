/**
 * SolutionPack 契约 re-export。
 *
 * 权威定义在 `@weflow/solution-sdk`（含 zod schema 与校验逻辑）；本文件只做
 * **纯类型** re-export，使平台与 Solutions 可以统一从 `@weflow/contracts`
 * 消费包契约类型，而不会把 Node crypto 拖进浏览器 bundle。
 *
 * 需要运行时校验（parse/verify/digest）时，请直接 import
 * `@weflow/solution-sdk`。
 */
export type {
  SolutionManifestV1,
  SolutionLockV1,
  SolutionSignature,
  SolutionDescriptor,
  SolutionPackageFiles,
  SolutionPackageDescriptor,
  SolutionMetadata,
  SolutionCompatibility,
  SolutionDependencies,
  SolutionArtifact,
  SolutionPermission,
  SolutionSecretSlot,
  SolutionResource,
  ExecutionProfile,
  SolutionApplication,
  HealthCheck,
  SolutionConsoleExtension,
} from "@weflow-leaif/solution-sdk";
