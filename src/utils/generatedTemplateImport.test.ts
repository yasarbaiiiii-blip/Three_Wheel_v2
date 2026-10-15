import { describe, expect, it, vi } from "vitest";
import type { LocalDxfResult } from "./dxfLocalImport";
import { importGeneratedTemplateToFields } from "./generatedTemplateImport";

const parsed = { fileName: "Template.dxf", lines: [] } as unknown as LocalDxfResult;

describe("importGeneratedTemplateToFields", () => {
  it("yields first and commits one parsed template in order", async () => {
    const order: string[] = [];
    const begin = vi.fn(() => order.push("begin"));
    const accept = vi.fn(() => order.push("parsed"));
    const setPlan = vi.fn(() => order.push("plan"));

    const result = await importGeneratedTemplateToFields({
      title: "Road Sign",
      buildLines: () => {
        order.push("build");
        return [{ id: "a" } as never];
      },
      yieldBeforeWork: async () => {
        order.push("yield");
      },
      encodeDxf: (_lines, name) => {
        order.push(`encode:${name}`);
        return "DXF";
      },
      parseDxf: (_text, name) => {
        order.push(`parse:${name}`);
        return { ...parsed, fileName: name };
      },
      onBeginLocalImportBatch: begin,
      onLocalDxfParsed: accept,
      setImportedPlan: setPlan,
    });

    expect(result.fileName).toBe("Road_Sign.dxf");
    expect(order).toEqual([
      "yield",
      "build",
      "encode:Road_Sign.dxf",
      "parse:Road_Sign.dxf",
      "begin",
      "parsed",
      "plan",
    ]);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(setPlan).toHaveBeenCalledTimes(1);
  });

  it("does not clear or mutate the current plan when generation/parsing fails", async () => {
    const begin = vi.fn();
    const accept = vi.fn();
    const setPlan = vi.fn();

    await expect(
      importGeneratedTemplateToFields({
        title: "Broken",
        buildLines: () => [{ id: "a" } as never],
        yieldBeforeWork: async () => undefined,
        encodeDxf: () => {
          throw new Error("encode failed");
        },
        onBeginLocalImportBatch: begin,
        onLocalDxfParsed: accept,
        setImportedPlan: setPlan,
      })
    ).rejects.toThrow("encode failed");

    expect(begin).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(setPlan).not.toHaveBeenCalled();
  });
});
