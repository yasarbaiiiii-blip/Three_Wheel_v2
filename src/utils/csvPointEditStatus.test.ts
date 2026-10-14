import { describe, expect, it } from "vitest";
import { describeCsvEditStatus, isSendBlockedByEmptyEdit, isStaleSend } from "./csvPointEditStatus";
import { replacePrefixedLinesInPlace } from "./csvFileLines";
import type { PlanLine } from "../types/plan";

const base = {
  editMode: true,
  rangeMode: false,
  selectedCount: 0,
  deletedCount: 0,
  remainingTotal: 24,
  summaries: [{ fileName: "survey.csv", pointsOnlyGroups: 0, remainingCount: 24, totalPoints: 24 }],
};

describe("describeCsvEditStatus", () => {
  it("shows an untouched file plainly", () => {
    const s = describeCsvEditStatus(base);
    expect(s.headline).toBe("24 points · none removed");
    expect(s.notices).toEqual([]);
    expect(s.hint).toMatch(/original CSV is not changed/);
  });

  it("shows how many were removed", () => {
    const s = describeCsvEditStatus({ ...base, deletedCount: 3, remainingTotal: 21 });
    expect(s.headline).toBe("21 of 24 points kept · 3 points removed");
    expect(describeCsvEditStatus({ ...base, deletedCount: 1, remainingTotal: 23 }).headline).toContain("1 point removed");
  });

  it("describes the selection and range states", () => {
    expect(describeCsvEditStatus({ ...base, selectedCount: 2 }).hint).toContain("2 points selected");
    expect(describeCsvEditStatus({ ...base, selectedCount: 1 }).hint).toContain("1 point selected");
    expect(describeCsvEditStatus({ ...base, rangeMode: true }).hint).toMatch(/Range/);
  });

  it("never silently drops a points-only group", () => {
    const s = describeCsvEditStatus({
      ...base,
      summaries: [{ fileName: "survey.csv", pointsOnlyGroups: 2, remainingCount: 20, totalPoints: 24 }],
    });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0].level).toBe("warning");
    expect(s.notices[0].text).toContain("2 groups");
    expect(s.notices[0].text).toContain("will not be painted");
  });

  it("flags an empty plan as an error", () => {
    const s = describeCsvEditStatus({ ...base, deletedCount: 24, remainingTotal: 0 });
    expect(s.notices.some((n) => n.level === "error" && /nothing to send/.test(n.text))).toBe(true);
  });
});

describe("send guards", () => {
  it("blocks Send only when exactly zero CSV points remain", () => {
    expect(isSendBlockedByEmptyEdit(0)).toBe(true);
    expect(isSendBlockedByEmptyEdit(1)).toBe(false);
    expect(isSendBlockedByEmptyEdit(null)).toBe(false);
    expect(isSendBlockedByEmptyEdit(undefined)).toBe(false);
  });

  it("a Send that raced an edit is stale; an unchanged or unknown revision is not", () => {
    expect(isStaleSend(3, 4)).toBe(true);
    expect(isStaleSend(3, 3)).toBe(false);
    expect(isStaleSend(undefined, 3)).toBe(false);
    expect(isStaleSend(3, undefined)).toBe(false);
  });

  it("simulated race: edit lands between capture and result", async () => {
    let revision = 7;
    const captured = revision;
    const upload = new Promise<void>((resolve) => setTimeout(resolve, 5));
    revision += 1; // operator deletes a point while the upload is in flight
    await upload;
    expect(isStaleSend(captured, revision)).toBe(true);
  });
});

const line = (id: string, layer: PlanLine["layer"] = "marking"): PlanLine =>
  ({ id, label: id, layer, from: { id: 1, x: 0, y: 0 }, to: { id: 2, x: 1, y: 1 }, width: 0.1 }) as PlanLine;

describe("replacePrefixedLinesInPlace", () => {
  it("keeps the file's lines where they were instead of moving them to the end", () => {
    const lines = [line("boundary", "virtual_boundary"), line("a__p1"), line("a__p2"), line("b__p1"), line("ext-pre-b__p1", "extension")];
    const out = replacePrefixedLinesInPlace(lines, "a", [line("a__p1")]);
    expect(out.map((l) => l.id)).toEqual(["boundary", "a__p1", "b__p1", "ext-pre-b__p1"]);
  });

  it("works for a file in the middle and for an empty replacement", () => {
    const lines = [line("a__p1"), line("b__p1"), line("b__p2"), line("c__p1")];
    expect(replacePrefixedLinesInPlace(lines, "b", [line("b__p1")]).map((l) => l.id)).toEqual(["a__p1", "b__p1", "c__p1"]);
    expect(replacePrefixedLinesInPlace(lines, "b", []).map((l) => l.id)).toEqual(["a__p1", "c__p1"]);
  });

  it("appends when the file has no lines yet (e.g. restored after deleting everything)", () => {
    const lines = [line("b__p1")];
    expect(replacePrefixedLinesInPlace(lines, "a", [line("a__p1")]).map((l) => l.id)).toEqual(["b__p1", "a__p1"]);
  });
});
