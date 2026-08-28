import { templateBoundsM } from "../../utils/arrowTemplates";
import { generateTextLines } from "../../utils/characterTemplates";
import { generateRoadSignLines, ROAD_SIGN_LABELS, type RoadSignType } from "../../utils/roadSignTemplates";

export type CatalogItem = {
  id: string;
  label: string;
  widthM: number;
  heightM: number;
};

export const SIGN_CATALOG: CatalogItem[] = (Object.keys(ROAD_SIGN_LABELS) as RoadSignType[]).map((id) => {
  const b = templateBoundsM(generateRoadSignLines(id, 1));
  return { id, label: ROAD_SIGN_LABELS[id], widthM: b.widthM, heightM: b.heightM };
});

export const CHAR_CATALOG: CatalogItem[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("").map((ch) => {
  const b = templateBoundsM(generateTextLines(ch, 1, "smooth", 0.12));
  return { id: ch, label: ch, widthM: b.widthM, heightM: b.heightM };
});
