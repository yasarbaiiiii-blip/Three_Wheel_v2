import { describe, expect, it } from "vitest";
import { INITIAL_STAGED_WORKFLOW_STATE, invalidateWorkflowFrom, type StagedWorkflowState } from "./fieldsWorkflow";

const allVerified: StagedWorkflowState = { alignment: "verified", spray: "verified", staged: "verified" };

describe("invalidateWorkflowFrom", () => {
  it("a new alignment demotes alignment, spray and the stored mission", () => {
    expect(invalidateWorkflowFrom(allVerified, "alignment")).toEqual(INITIAL_STAGED_WORKFLOW_STATE);
  });

  it("a path-order edit keeps the alignment but demotes spray and the stored mission", () => {
    expect(invalidateWorkflowFrom(allVerified, "spray")).toEqual({
      alignment: "verified",
      spray: "pending",
      staged: "pending",
    });
  });

  it("a stale stored mission keeps everything before it", () => {
    expect(invalidateWorkflowFrom(allVerified, "staged")).toEqual({
      alignment: "verified",
      spray: "verified",
      staged: "pending",
    });
  });

  it("has no load or started step: Start does everything", () => {
    expect(Object.keys(INITIAL_STAGED_WORKFLOW_STATE).sort()).toEqual(["alignment", "spray", "staged"]);
  });

  it("does not mutate its input", () => {
    const input = { ...allVerified };
    invalidateWorkflowFrom(input, "alignment");
    expect(input).toEqual(allVerified);
  });
});
