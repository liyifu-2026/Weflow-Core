/**
 * fetch_url 公网校验的单元测试：钉住 SSRF 审计（P0-2）确认过的绕过向量
 * ——hex 形式 IPv4-mapped、6to4、NAT64 内嵌私网 v4 必须按内嵌地址判定。
 */
import { describe, expect, it } from "vitest";
import {
  isPublicIPv4,
  isPublicIPv6,
} from "../modules/agent/application/execute-tool-plan.js";

describe("fetch_url public-ip classification", () => {
  it("classifies IPv4 private/reserved ranges as non-public", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "198.18.0.1",
    ]) {
      expect(ip, ip).toSatisfy((v: string) => !isPublicIPv4(v));
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "114.114.114.114"]) {
      expect(isPublicIPv4(ip), ip).toBe(true);
    }
  });

  it("blocks hex-form IPv4-mapped loopback (audit bypass vector)", () => {
    // ::ffff:7f00:1 与 ::ffff:127.0.0.1 是同一地址的两种写法
    expect(isPublicIPv6("::ffff:7f00:1")).toBe(false);
    expect(isPublicIPv6("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIPv6("::ffff:0a00:0001")).toBe(false); // 10.0.0.1
    expect(isPublicIPv6("::ffff:8.8.8.8")).toBe(true); // 公网映射放行
  });

  it("judges 6to4 by the embedded IPv4", () => {
    expect(isPublicIPv6("2002:7f00:1::")).toBe(false); // 内嵌 127.0.0.1
    expect(isPublicIPv6("2002:0a00:0001::")).toBe(false); // 内嵌 10.0.0.1
    expect(isPublicIPv6("2002:0808:0808::")).toBe(true); // 内嵌 8.8.8.8
  });

  it("blocks Teredo outright and judges NAT64 by embedded IPv4", () => {
    expect(isPublicIPv6("2001:0::1")).toBe(false);
    expect(isPublicIPv6("64:ff9b::7f00:1")).toBe(false); // 内嵌 127.0.0.1
    expect(isPublicIPv6("64:ff9b::808:808")).toBe(true); // 内嵌 8.8.8.8
  });

  it("blocks other non-routable IPv6", () => {
    for (const ip of ["::", "::1", "fe80::1", "fd00::1", "ff02::1", "2001:db8::1"]) {
      expect(isPublicIPv6(ip), ip).toBe(false);
    }
    expect(isPublicIPv6("2606:4700:4700::1111")).toBe(true);
  });

  it("fails closed on malformed IPv6", () => {
    expect(isPublicIPv6("not-an-ip")).toBe(false);
    expect(isPublicIPv6("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isPublicIPv6("::::")).toBe(false);
  });
});
