/**
 * Offline basemap packs (native Mapbox). Sizing maths lives in offlineMapMath.ts.
 *
 * Why: the rover's hotspot usually has no internet, and the satellite style/tiles only load
 * from Mapbox's servers. A pack downloaded once, on a connection that has internet, makes the
 * map load from disk at the site — no "Loading map…", no timeouts.
 */
import Mapbox from "@rnmapbox/maps";

import { MAPBOX_STYLE_URL } from "../config/mapbox";
import {
  isValidBounds,
  padBounds,
  planZoomRange,
  type MapBounds,
  type ZoomPlan,
} from "./offlineMapMath";

export type OfflineRegion = {
  name: string;
  percentage: number;
  sizeBytes: number;
  complete: boolean;
};

/** Packs this app created. Anything else in the Mapbox database is left alone. */
export const SITE_PACK_PREFIX = "site-";

export type DownloadProgress = { percentage: number; plan: ZoomPlan };

export function planSiteDownload(visible: MapBounds | null): { bounds: MapBounds; plan: ZoomPlan } | null {
  if (!isValidBounds(visible)) return null;
  const bounds = padBounds(visible, 0.25);
  return { bounds, plan: planZoomRange(bounds) };
}

/**
 * Download the area on screen (plus a margin). Resolves when the pack is complete, rejects on
 * a native error. `onProgress` gets 0–100.
 */
export async function downloadSiteMap(
  visible: MapBounds,
  onProgress: (p: DownloadProgress) => void
): Promise<{ name: string; plan: ZoomPlan }> {
  const planned = planSiteDownload(visible);
  if (!planned) throw new Error("The map area is not valid. Pan the map over your site and try again.");
  const { bounds, plan } = planned;
  const name = `${SITE_PACK_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      Mapbox.offlineManager.unsubscribe(name);
      if (err) reject(err);
      else resolve();
    };
    Mapbox.offlineManager
      .createPack(
        {
          name,
          styleURL: MAPBOX_STYLE_URL,
          bounds,
          minZoom: plan.minZoom,
          maxZoom: plan.maxZoom,
          metadata: { createdAt: Date.now(), tiles: plan.tiles },
        },
        (_pack, status) => {
          const pct = Math.max(0, Math.min(100, Number(status?.percentage ?? 0)));
          onProgress({ percentage: pct, plan });
          if (pct >= 100) finish();
        },
        (_pack, err) => finish(new Error(String((err as { message?: string })?.message ?? "Offline download failed.")))
      )
      .catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
  });
  return { name, plan };
}

export async function listSiteMaps(): Promise<OfflineRegion[]> {
  const packs = await Mapbox.offlineManager.getPacks();
  const out: OfflineRegion[] = [];
  for (const pack of packs) {
    const name = String(pack.name ?? "");
    if (!name.startsWith(SITE_PACK_PREFIX)) continue;
    try {
      const st = await pack.status();
      out.push({
        name,
        percentage: st.percentage,
        sizeBytes: st.completedResourceSize,
        complete: st.percentage >= 100,
      });
    } catch {
      out.push({ name, percentage: 0, sizeBytes: 0, complete: false });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function deleteSiteMap(name: string): Promise<void> {
  if (!name.startsWith(SITE_PACK_PREFIX)) return;
  await Mapbox.offlineManager.deletePack(name);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
