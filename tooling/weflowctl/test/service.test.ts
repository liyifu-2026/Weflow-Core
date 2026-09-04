/**
 * service 域单元测试（node:test）：纯函数部分（XML 渲染、名称推导、
 * 用法/完成脚本），不依赖 Windows 服务控制（不触发真实 sc/WinSW）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SERVICE_KEYS,
  WINSW_HOST_EXE,
  renderWinswXml,
  serviceNames,
  SERVICE_USAGE,
} from "../src/service/definitions.js";
import { bashCompletion, powershellCompletion, zshCompletion } from "../src/cli-completion.js";

describe("serviceNames", () => {
  it("每个服务键推导出 weflow-<key> 服务名", () => {
    for (const key of SERVICE_KEYS) {
      const names = serviceNames(key);
      assert.equal(names.serviceName, `weflow-${key}`);
      assert.match(names.display, new RegExp(key.replace("-", ".")));
    }
  });
});

describe("renderWinswXml", () => {
  const coreDir = "C:\\deploy\\weflow\\core";
  const nodeExe = "C:\\Program Files\\nodejs\\node.exe";
  const logDir = "C:\\deploy\\weflow\\logs";

  it("core-api 指向 dist/apps/api/main.js 且工作目录为 core", () => {
    const xml = renderWinswXml(coreDir, nodeExe, "core-api", logDir);
    assert.match(xml, /<id>weflow-core-api<\/id>/);
    assert.match(xml, /<arguments>--env-file=\.env dist\/apps\/api\/main\.js<\/arguments>/);
    assert.match(xml, new RegExp(`<workingdirectory>[^<]*core[^<]*</workingdirectory>`));
  });

  it("agent-worker / ingestion-worker 指向各自入口", () => {
    assert.match(
      renderWinswXml(coreDir, nodeExe, "agent-worker", logDir),
      /dist\/apps\/agent-worker\/main\.js/,
    );
    assert.match(
      renderWinswXml(coreDir, nodeExe, "ingestion-worker", logDir),
      /dist\/apps\/ingestion-worker\/main\.js/,
    );
  });

  it("包含崩溃重启策略与自动启动（延迟）", () => {
    const xml = renderWinswXml(coreDir, nodeExe, "core-api", logDir);
    assert.match(xml, /<startmode>Automatic<\/startmode>/);
    assert.match(xml, /<delayedAutoStart>true<\/delayedAutoStart>/);
    assert.match(xml, /<onfailure action="restart" delay="10 sec"\/>/);
    assert.match(xml, /<onfailure action="restart" delay="30 sec"\/>/);
    assert.match(xml, /<env name="NODE_ENV" value="production"\/>/);
  });

  it("对路径中的 XML 特殊字符转义", () => {
    const xml = renderWinswXml("C:\\a&b<c>d", nodeExe, "core-api", logDir);
    assert.match(xml, /C:\\a&amp;b&lt;c&gt;d/);
  });
});

describe("service usage / host exe", () => {
  it("用法覆盖全部动词", () => {
    for (const verb of ["install", "uninstall", "start", "stop", "restart", "status"]) {
      assert.match(SERVICE_USAGE, new RegExp(verb));
    }
  });
  it("host exe 固定名", () => {
    assert.equal(WINSW_HOST_EXE, "weflow-service.exe");
  });
});

describe("completion 脚本包含 service 域", () => {
  it("bash/zsh/powershell 均列出 service", () => {
    assert.match(bashCompletion(), /domains="dev service config completion"/);
    assert.match(zshCompletion(), /domains=\(dev service config completion\)/);
    assert.match(powershellCompletion(), /'service' \{/);
  });
  it("powershell 补全包含 service 动词", () => {
    assert.match(powershellCompletion(), /install\|uninstall\|start\|stop\|restart\|status/);
  });
});
