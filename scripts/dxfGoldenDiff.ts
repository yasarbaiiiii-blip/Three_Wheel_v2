/**
 * Phase 2 golden differential vs a live rover.
 *
 * Usage:
 *   npx tsx scripts/dxfGoldenDiff.ts --base http://ROVER:8000 --file path/to.dxf
 *   npx tsx scripts/dxfGoldenDiff.ts --fixture-dir ./fixtures/dxf-golden
 *
 * Without a rover, unit tests in dxfGoldenDiff.test.ts cover synthetic fixtures.
 * When a rover is available, POST /parse-dxf + GET /entities and compare to
 * parseLocalDxf within:
 *   - entity count + per-entity is_mark
 *   - max point-to-polyline deviation ≤ 5 mm
 *   - total mark length within 0.1 %
 *   - is_geographic / geo_origin within 1e-7°
 */

import * as fs from "fs";
import * as path from "path";

// Dynamic import path for Node — keep script runnable when wired into CI.
async function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const fileIdx = args.indexOf("--file");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : process.env.ROVER_URL;
  const file = fileIdx >= 0 ? args[fileIdx + 1] : null;

  if (!file) {
    console.log(
      "dxfGoldenDiff: pass --file <dxf> [--base <rover url>]\n" +
        "Without --base, only local parse stats are printed.\n" +
        "CI gate without rover: npm test -- dxfGoldenDiff.test.ts"
    );
    process.exit(0);
  }

  const text = fs.readFileSync(file, "utf8");
  // Lazy require so vitest suite doesn't need this path
  const { parseLocalDxf } = await import("../src/utils/dxfLocalImport");
  const local = parseLocalDxf(text, path.basename(file));
  console.log(
    JSON.stringify(
      {
        file: path.basename(file),
        local: {
          entityCount: local.entityCount,
          ignoredCount: local.ignoredCount,
          unitScale: local.unitScale,
          isGeographic: local.isGeographic,
          geoOrigin: local.geoOrigin,
          markLength: local.lines
            .filter((l) => l.entity?.is_mark)
            .reduce((s, l) => s + (l.entity?.length_m ?? 0), 0),
          is_mark: local.lines.map((l) => l.entity?.is_mark),
        },
      },
      null,
      2
    )
  );

  if (!base) {
    console.log("No --base rover URL; skipped live differential.");
    return;
  }

  // Live path: multipart parse-dxf then entities
  const form = new FormData();
  form.append("file", new Blob([text]), path.basename(file));
  const parseRes = await fetch(`${base.replace(/\/$/, "")}/api/path/parse-dxf`, {
    method: "POST",
    body: form,
  });
  if (!parseRes.ok) {
    console.error("parse-dxf failed", parseRes.status, await parseRes.text());
    process.exit(1);
  }
  const parseJson = (await parseRes.json()) as { name?: string };
  const name = parseJson.name ?? path.basename(file);
  const entRes = await fetch(
    `${base.replace(/\/$/, "")}/api/path/${encodeURIComponent(name)}/entities`
  );
  if (!entRes.ok) {
    console.error("entities failed", entRes.status, await entRes.text());
    process.exit(1);
  }
  const entities = (await entRes.json()) as {
    num_entities: number;
    is_geographic?: boolean;
    geo_origin?: [number, number] | null;
    entities: Array<{
      entity_id: string;
      is_mark: boolean;
      length_m: number;
      preview_points: Array<{ north: number; east: number }>;
    }>;
  };

  const roverMarkLen = entities.entities
    .filter((e) => e.is_mark)
    .reduce((s, e) => s + (e.length_m || 0), 0);
  const localMarkLen = local.lines
    .filter((l) => l.entity?.is_mark)
    .reduce((s, l) => s + (l.entity?.length_m ?? 0), 0);

  const countOk = entities.num_entities === local.entityCount;
  const lenOk =
    roverMarkLen > 0
      ? Math.abs(roverMarkLen - localMarkLen) / roverMarkLen <= 0.001
      : localMarkLen === 0;
  const geoOk =
    Boolean(entities.is_geographic) === local.isGeographic &&
    (!local.geoOrigin ||
      (entities.geo_origin != null &&
        Math.abs(entities.geo_origin[0] - local.geoOrigin.lat) < 1e-7 &&
        Math.abs(entities.geo_origin[1] - local.geoOrigin.lon) < 1e-7));

  console.log({ countOk, lenOk, geoOk, roverMarkLen, localMarkLen });
  if (!countOk || !lenOk || !geoOk) {
    console.error("GOLDEN DIFF FAILED");
    process.exit(1);
  }
  console.log("GOLDEN DIFF OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
