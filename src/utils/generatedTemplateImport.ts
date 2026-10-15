import type { PlanLine, ImportedPlan } from "../types/plan";
import { linesToDxf } from "./dxfGenerator";
import { parseLocalDxf, type LocalDxfResult } from "./dxfLocalImport";
import { yieldToUi } from "./runtimeGuards";

export type GeneratedTemplateImportResult = {
  fileName: string;
  parsed: LocalDxfResult;
};

/**
 * One deterministic generated-template handoff. The UI gets a frame to paint its busy state before
 * synchronous DXF generation/parsing starts; callbacks run only after parsing has fully succeeded.
 */
export async function importGeneratedTemplateToFields(args: {
  title: string;
  buildLines: () => PlanLine[];
  onBeginLocalImportBatch?: () => void;
  onLocalDxfParsed?: (data: LocalDxfResult) => void;
  setImportedPlan: (plan: ImportedPlan) => void;
  yieldBeforeWork?: () => Promise<void>;
  encodeDxf?: typeof linesToDxf;
  parseDxf?: typeof parseLocalDxf;
}): Promise<GeneratedTemplateImportResult> {
  const yieldBeforeWork = args.yieldBeforeWork ?? yieldToUi;
  await yieldBeforeWork();

  const lines = args.buildLines();
  if (lines.length === 0) throw new Error("The template has no drawable strokes.");

  const fileName = `${args.title.replace(/\s+/g, "_")}.dxf`;
  const encodeDxf = args.encodeDxf ?? linesToDxf;
  const parseDxf = args.parseDxf ?? parseLocalDxf;
  const parsed = parseDxf(encodeDxf(lines, fileName), fileName);

  // Do not clear the current mission until generation and parsing have succeeded.
  args.onBeginLocalImportBatch?.();
  args.onLocalDxfParsed?.(parsed);
  args.setImportedPlan({ fileName, uri: "", fileType: "dxf", source: "generated" });
  return { fileName, parsed };
}
