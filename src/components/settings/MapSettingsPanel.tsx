import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { useSharedMapEnabled, setSharedMapEnabled } from "../sharedMap/mapPrefs";
import { getVisibleMapBounds } from "../sharedMap/sharedMapStore";
import {
  deleteSiteMap,
  downloadSiteMap,
  formatBytes,
  listSiteMaps,
  planSiteDownload,
  type OfflineRegion,
} from "../../utils/offlineMap";

const C = {
  panel: "#18181b",
  card: "#1f1f24",
  border: "#2e2e34",
  text: "#f8fafc",
  dim: "#64748b",
  muted: "#94a3b8",
  brand: "#f4c10c",
  brandText: "#1c1c1c",
  danger: "#ef4444",
  success: "#10b981",
};

export function MapSettingsPanel() {
  const shared = useSharedMapEnabled();
  const [regions, setRegions] = useState<OfflineRegion[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRegions(await listSiteMaps());
    } catch {
      // Native module unavailable (dev client without offline support): keep the list empty.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = async () => {
    if (busy) return;
    setNote(null);
    const bounds = await getVisibleMapBounds();
    const planned = planSiteDownload(bounds);
    if (!planned) {
      Alert.alert(
        "Open the map first",
        "Go to Home or Fields, pan and zoom the map over your work site, then come back and tap Download."
      );
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const { plan } = planned;
      setNote(
        `Downloading ~${plan.tiles} tiles (zoom ${plan.minZoom}–${plan.maxZoom})` +
          (plan.capped ? " — area is large, so detail is reduced." : ".")
      );
      await downloadSiteMap(bounds!, (p) => setProgress(p.percentage));
      setNote("Saved. This area now loads without internet.");
    } catch (e) {
      setNote(null);
      Alert.alert(
        "Download failed",
        (e instanceof Error ? e.message : "Could not download the map.") +
          "\n\nDownloading needs an internet connection (not the rover hotspot alone)."
      );
    } finally {
      setBusy(false);
      setProgress(null);
      void refresh();
    }
  };

  const remove = (r: OfflineRegion) => {
    Alert.alert("Delete offline map", `Remove ${r.name.replace("site-", "saved area ")}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteSiteMap(r.name).then(refresh).catch(() => refresh());
        },
      },
    ]);
  };

  return (
    <View style={s.panel}>
      <Text style={s.title}>Map</Text>

      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>One shared map (recommended)</Text>
          <Text style={s.hint}>
            Home and Fields use the same map, so zoom and position carry over and screens switch
            without reloading. Turn off only if the map ever shows blank on a screen.
          </Text>
        </View>
        <Switch
          value={shared}
          onValueChange={setSharedMapEnabled}
          trackColor={{ false: "#252529", true: C.brand }}
          thumbColor={shared ? C.brandText : C.muted}
        />
      </View>

      <View style={s.divider} />

      <Text style={s.label}>Offline map</Text>
      <Text style={s.hint}>
        Save the area you are looking at on the map (plus a margin) so it loads at the site
        without internet. Do this once, on a connection that has internet.
      </Text>

      <Pressable
        onPress={download}
        disabled={busy}
        accessibilityRole="button"
        style={[s.btn, busy && { opacity: 0.6 }]}
      >
        {busy ? (
          <View style={s.btnInner}>
            <ActivityIndicator size="small" color={C.brandText} />
            <Text style={s.btnText}>{progress != null ? `Downloading… ${Math.round(progress)}%` : "Downloading…"}</Text>
          </View>
        ) : (
          <Text style={s.btnText}>Download map for current view</Text>
        )}
      </Pressable>
      {note ? <Text style={s.note}>{note}</Text> : null}

      {regions.map((r) => (
        <View key={r.name} style={s.region}>
          <View style={{ flex: 1 }}>
            <Text style={s.regionName} numberOfLines={1}>
              {r.name.replace("site-", "Saved area ").replace("T", " ").slice(0, 31)}
            </Text>
            <Text style={s.hint}>
              {r.complete ? "Complete" : `${Math.round(r.percentage)}%`} · {formatBytes(r.sizeBytes)}
            </Text>
          </View>
          <Pressable onPress={() => remove(r)} accessibilityLabel="Delete offline map" style={s.del}>
            <Text style={s.delText}>Delete</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    backgroundColor: C.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    gap: 8,
  },
  title: { color: C.text, fontSize: 14, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  label: { color: C.text, fontSize: 13, fontWeight: "600" },
  hint: { color: C.dim, fontSize: 11, lineHeight: 15, marginTop: 2 },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 4 },
  btn: {
    height: 40,
    borderRadius: 10,
    backgroundColor: C.brand,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  btnInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  btnText: { color: C.brandText, fontSize: 13, fontWeight: "800" },
  note: { color: C.muted, fontSize: 11, lineHeight: 15 },
  region: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 8,
  },
  regionName: { color: C.text, fontSize: 12, fontWeight: "600" },
  del: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: C.danger },
  delText: { color: C.danger, fontSize: 11, fontWeight: "700" },
});
