/**
 * SSE 帧解析测试
 * 重点覆盖真实流式响应最容易出错的两点：跨 chunk 切帧与心跳帧忽略。
 */
import { describe, expect, it } from "vitest";
import {
  createSseEventParser,
  isConversationStreamEvent,
} from "./sse-parser";

const event = {
  type: "agent_message",
  conversationId: "channel:demo",
  occurredAt: "2026-09-08T00:00:00.000Z",
  messageId: "agent-message:1",
};

/** Core 写入的帧格式：id / event / data 三行 + 空行 */
const frame = (payload: unknown, type = "agent_message") =>
  `id: 1\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

describe("sse event parser", () => {
  it("parses a single complete frame", () => {
    const parser = createSseEventParser();
    expect(parser.push(frame(event))).toEqual([event]);
  });

  it("parses multiple frames arriving in one chunk", () => {
    const parser = createSseEventParser();
    const second = { ...event, messageId: "agent-message:2" };
    expect(parser.push(frame(event) + frame(second))).toEqual([event, second]);
  });

  it("buffers a frame split across chunks", () => {
    const parser = createSseEventParser();
    const text = frame(event);
    expect(parser.push(text.slice(0, 10))).toEqual([]);
    expect(parser.push(text.slice(10))).toEqual([event]);
  });

  it("buffers a frame split at the exact boundary marker", () => {
    const parser = createSseEventParser();
    const text = frame(event);
    const cut = text.length - 1;
    expect(parser.push(text.slice(0, cut))).toEqual([]);
    expect(parser.push(text.slice(cut))).toEqual([event]);
  });

  it("ignores heartbeat comment frames", () => {
    const parser = createSseEventParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
  });

  it("ignores invalid JSON payloads", () => {
    const parser = createSseEventParser();
    expect(parser.push("data: {not json\n\n")).toEqual([]);
  });

  it("ignores payloads without the required fields", () => {
    const parser = createSseEventParser();
    expect(parser.push("data: {\"type\":\"agent_message\"}\n\n")).toEqual([]);
  });

  it("concatenates multi-line data fields", () => {
    const parser = createSseEventParser();
    const payload = JSON.stringify(event);
    const split = Math.floor(payload.length / 2);
    const chunk = `data: ${payload.slice(0, split)}\ndata: ${payload.slice(split)}\n\n`;
    expect(parser.push(chunk)).toEqual([event]);
  });

  it("keeps a trailing partial frame buffered until completed", () => {
    const parser = createSseEventParser();
    expect(parser.push(frame(event) + "id: 2\nevent: agent_message\ndata: {")).toEqual([
      event,
    ]);
  });
});

describe("conversation stream event validation", () => {
  it("accepts an event payload with required string fields", () => {
    expect(isConversationStreamEvent(event)).toBe(true);
  });

  it("rejects non-objects and missing fields", () => {
    expect(isConversationStreamEvent(null)).toBe(false);
    expect(isConversationStreamEvent("agent_message")).toBe(false);
    expect(isConversationStreamEvent({ type: "agent_message" })).toBe(false);
    expect(
      isConversationStreamEvent({ ...event, conversationId: 42 }),
    ).toBe(false);
  });
});
