/**
 * 接待编排纯函数测试（Node 内置 test runner，无新增依赖）。
 * 覆盖：提取容错、关键词命中、大小写、顺序优先、fail-open 空值。
 *
 * 运行：node --test src/reception-plan.test.ts（或编译后对 dist 运行）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractReceptionPlan,
  matchEmployeeRoute,
} from "./reception-plan.js";

describe("extractReceptionPlan", () => {
  it("畸形输入一律回落空计划", () => {
    for (const raw of [undefined, null, 42, "x", {}, { pipeline: null }]) {
      const plan = extractReceptionPlan(raw);
      assert.equal(plan.defaultEmployeeKey, null);
      assert.deepEqual(plan.employeeRoutes, []);
    }
  });

  it("丢弃缺关键词或缺员工键的路由，保留合法路由", () => {
    const plan = extractReceptionPlan({
      pipeline: {
        defaultEmployeeKey: "after-sales",
        employeeRoutes: [
          { id: "a", keywords: ["退货"], employeeKey: "after-sales" },
          { id: "b", keywords: [], employeeKey: "tech" },
          { id: "c", keywords: ["投诉"], employeeKey: "" },
          { id: "d", keywords: ["  ", null, 3], employeeKey: "tech" },
          "junk",
        ],
      },
    });
    assert.equal(plan.defaultEmployeeKey, "after-sales");
    assert.equal(plan.employeeRoutes.length, 1);
    assert.deepEqual(plan.employeeRoutes[0], {
      keywords: ["退货"],
      employeeKey: "after-sales",
    });
  });

  it("空白 defaultEmployeeKey 视为未设置", () => {
    const plan = extractReceptionPlan({
      pipeline: { defaultEmployeeKey: "   " },
    });
    assert.equal(plan.defaultEmployeeKey, null);
  });
});

describe("matchEmployeeRoute", () => {
  const routes = [
    { keywords: ["退货", "退款"], employeeKey: "after-sales" },
    { keywords: ["报错"], employeeKey: "tech" },
  ];

  it("自上而下第一条命中生效", () => {
    assert.equal(matchEmployeeRoute("我要退货", routes), "after-sales");
    assert.equal(matchEmployeeRoute("系统报错了", routes), "tech");
  });

  it("大小写不敏感", () => {
    assert.equal(
      matchEmployeeRoute("Please REFUND", [{ keywords: ["refund"], employeeKey: "r" }]),
      "r",
    );
  });

  it("无命中 / 空文本 / 空路由返回 null", () => {
    assert.equal(matchEmployeeRoute("你好", routes), null);
    assert.equal(matchEmployeeRoute("", routes), null);
    assert.equal(matchEmployeeRoute("退货", []), null);
  });
});
