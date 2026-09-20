# Weflow Core 生产镜像
#
# 构建上下文必须是仓库根：core 通过 `link:../packages/contracts` 依赖共享契约包，
# 两个包必须一起进入构建（在仓库根执行）：
#   docker build -f core/Dockerfile -t weflow-core .
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable

# registry 可在构建时覆盖（国内网络示例：
#   --build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com ）
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}

# 1) 公共契约包：core 的类型与运行时值都指向它的构建产物，必须先装先建
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/tsconfig.build.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
RUN cd packages/contracts && pnpm install && pnpm build

# 2) Core：先只拷清单装依赖（利用层缓存），再拷源码构建
COPY core/package.json core/pnpm-lock.yaml core/pnpm-workspace.yaml ./core/
WORKDIR /app/core
RUN pnpm install --frozen-lockfile

COPY core/tsconfig.json core/tsconfig.build.json ./
COPY core/apps ./apps
COPY core/infrastructure ./infrastructure
COPY core/modules ./modules
COPY core/scripts ./scripts
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
# 与 build 阶段保持同构布局：node_modules 里指向 packages/contracts 的
# link 符号链接在两个阶段解析到相同路径，拷贝不碎。
WORKDIR /app/core
COPY --from=build /app/packages/contracts /app/packages/contracts
COPY core/package.json core/pnpm-lock.yaml ./
COPY --from=build /app/core/node_modules ./node_modules
COPY --from=build /app/core/dist ./dist
COPY core/migrations ./migrations

USER node
CMD ["node", "dist/apps/api/main.js"]
