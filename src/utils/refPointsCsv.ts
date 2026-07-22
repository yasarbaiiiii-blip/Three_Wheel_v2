export type GuidePoint = { latRaw: string; lonRaw: string };

/** Splits one CSV line into trimmed cells, honoring double-quoted values. */
export function splitCsvCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Parses a PURE visual reference-point CSV: only Latitude/Longitude are read (any other
 * columns, e.g. a survey device's own Easting/Northing in some arbitrary project grid, are
 * ignored — they don't need to correspond to this drawing's coordinate system at all, since
 * these points are just a visual marker on the map, not an input to a computed fit).
 * Accepts a header row (lat/latitude, lon/lng/long/longitude, any order) or, with no
 * recognizable header, 2 bare numeric columns in that order (lat, lon).
 */
export function parseGuidePointsCsv(text: string): { points: GuidePoint[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  if (lines.length === 0) return { points: [], errors: ["The file is empty."] };

  const headerCells = splitCsvCells(lines[0]).map((cell) => cell.toLowerCase());
  const latAliases = ["lat", "latitude"];
  const lonAliases = ["lon", "lng", "long", "longitude"];
  let latIdx = headerCells.findIndex((cell) => latAliases.includes(cell));
  let lonIdx = headerCells.findIndex((cell) => lonAliases.includes(cell));

  let dataLines: string[];
  if (latIdx >= 0 && lonIdx >= 0) {
    dataLines = lines.slice(1);
  } else {
    latIdx = 0;
    lonIdx = 1;
    const firstRowIsNumeric =
      headerCells.length >= 2 && headerCells.slice(0, 2).every((cell) => cell !== "" && Number.isFinite(Number(cell)));
    if (!firstRowIsNumeric && lines.length < 2) {
      return {
        points: [],
        errors: ["Could not find Latitude/Longitude columns. Expected a header row like: lat,lon"],
      };
    }
    dataLines = firstRowIsNumeric ? lines : lines.slice(1);
  }

  const points: GuidePoint[] = [];
  dataLines.forEach((line, i) => {
    const cells = splitCsvCells(line);
    if (cells.every((cell) => cell === "")) return;
    const rowNum = i + (dataLines.length === lines.length ? 1 : 2);

    const rawLat = cells[latIdx] ?? "";
    const rawLon = cells[lonIdx] ?? "";
    if (rawLat === "" || rawLon === "") {
      errors.push(`Row ${rowNum}: missing latitude/longitude.`);
      return;
    }
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      errors.push(`Row ${rowNum}: could not parse latitude/longitude.`);
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`Row ${rowNum}: latitude/longitude out of range.`);
      return;
    }
    points.push({ latRaw: rawLat, lonRaw: rawLon });
  });

  return { points, errors };
}
