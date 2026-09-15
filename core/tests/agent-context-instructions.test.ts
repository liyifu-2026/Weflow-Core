import { describe, expect, it } from "vitest";
import { dedupeSentInstructions } from "../modules/agent/application/agent-context.js";

describe("已发指令清单 dedupeSentInstructions", () => {
  it("keeps first occurrence order and drops normalized duplicates", () => {
    expect(
      dedupeSentInstructions([
        "灯亮就换个USB口重插。",
        "先看加密狗灯亮不亮。",
        " 灯亮就换个USB口重插。 ",
      ]),
    ).toEqual(["灯亮就换个USB口重插。", "先看加密狗灯亮不亮。"]);
  });

  it("treats whitespace-only differences as duplicates", () => {
    expect(
      dedupeSentInstructions([
        "插好再开一次软件，看还报不报2272。",
        "插好再开一次软件，看还报不报2272。\n",
      ]),
    ).toHaveLength(1);
  });

  it("keeps near-duplicates that are worded differently", () => {
    expect(
      dedupeSentInstructions([
        "灯亮就换个USB口重插。",
        "灯亮的话，先把加密狗换个USB口重插。",
      ]),
    ).toHaveLength(2);
  });

  it("drops pleasantries shorter than the instruction threshold", () => {
    expect(dedupeSentInstructions(["好的。", "在的。", "稍等。"])).toEqual([]);
  });

  it("caps the injected list at 12 entries", () => {
    const many = Array.from(
      { length: 20 },
      (_, index) => `第 ${String(index)} 步：重插加密狗。`,
    );
    expect(dedupeSentInstructions(many)).toHaveLength(12);
  });

  it("returns the trimmed original text, not the normalized key", () => {
    expect(dedupeSentInstructions(["  灯亮就换个USB口重插。  "])).toEqual([
      "灯亮就换个USB口重插。",
    ]);
  });
});
