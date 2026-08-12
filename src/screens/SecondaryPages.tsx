import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import Slider from "@react-native-community/slider";
import type { PlanLine } from "../types/plan";
import * as FileSystem from "expo-file-system/legacy";

const TEAL = "#0f988f";

const ModernSettingsPage = lazy(() => import("../components/ModernSettingsPage"));

type SprayParamPayloadValue = string | number | boolean;

type SprayControllerParam = {
  name: string;
  type: string;
  default: unknown;
  current: unknown;
  group?: string | null;
  description?: string | null;
  min?: number | null;
  max?: number | null;
};

const sprayParamTableHeaderStyle = {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 10,
  color: "#0f172a",
  fontSize: 12,
  fontWeight: "800",
} as const;

const sprayParamTableTextCellStyle = {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 10,
  color: "#334155",
  fontSize: 12,
} as const;

const sprayParamTableInputCellStyle = {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 6,
  justifyContent: "center",
} as const;

export function formatSprayParamValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function sprayParamKind(param: SprayControllerParam) {
  return String(param.type ?? "").trim().toLowerCase();
}

function isNumericSprayParam(param: SprayControllerParam) {
  const kind = sprayParamKind(param);
  return ["number", "float", "double", "integer", "int"].includes(kind);
}

function parseSprayParamInput(rawValue: string, param: SprayControllerParam): SprayParamPayloadValue {
  const value = rawValue.trim();
  const kind = sprayParamKind(param);

  if (["boolean", "bool"].includes(kind)) {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    throw new Error(`${param.name} must be true or false.`);
  }

  if (["integer", "int"].includes(kind)) {
    if (!/^-?\d+$/.test(value)) throw new Error(`${param.name} must be an integer.`);
    const parsed = Number.parseInt(value, 10);
    validateSprayParamRange(parsed, param);
    return parsed;
  }

  if (["number", "float", "double"].includes(kind)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${param.name} must be a number.`);
    validateSprayParamRange(parsed, param);
    return parsed;
  }

  return rawValue;
}

function validateSprayParamRange(value: number, param: SprayControllerParam) {
  if (typeof param.min === "number" && value < param.min) {
    throw new Error(`${param.name} must be at least ${param.min}.`);
  }
  if (typeof param.max === "number" && value > param.max) {
    throw new Error(`${param.name} must be at most ${param.max}.`);
  }
}

export function SwoziPage({
  delayA,
  delayB,
  setDelayA,
  setDelayB,
  toggleA,
  toggleB,
  setToggleA,
  setToggleB,
  apiBaseUrl,
  isFloatingEStopEnabled,
  setIsFloatingEStopEnabled,
}: {
  delayA: number;
  delayB: number;
  setDelayA: (v: number) => void;
  setDelayB: (v: number) => void;
  toggleA: boolean;
  toggleB: boolean;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  apiBaseUrl?: string;
  isFloatingEStopEnabled: boolean;
  setIsFloatingEStopEnabled: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [sprayDuration, setSprayDuration] = useState("2");
  const [sprayStatus, setSprayStatus] = useState(false);
  const [isTestActive, setIsTestActive] = useState(false);
  const [sprayParams, setSprayParams] = useState<SprayControllerParam[]>([]);
  const [editedSprayParams, setEditedSprayParams] = useState<Record<string, string>>({});
  const [isLoadingSprayParams, setIsLoadingSprayParams] = useState(false);
  const [isSavingSprayParams, setIsSavingSprayParams] = useState(false);
  const [isSprayHoldActive, setIsSprayHoldActive] = useState(false);
  const [isSprayHoldChanging, setIsSprayHoldChanging] = useState(false);

  const sprayApiUrl = useCallback((path: string) => {
    if (!apiBaseUrl) return "";
    return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
  }, [apiBaseUrl]);

  const loadSprayParams = useCallback(async () => {
    if (!apiBaseUrl) {
      setSprayParams([]);
      setEditedSprayParams({});
      return;
    }
    setIsLoadingSprayParams(true);
    try {
      const res = await fetch(sprayApiUrl("/api/spray/params"), {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || "Failed to load spray parameters.");
      }
      const data = await res.json();
      const params = Array.isArray(data?.parameters) ? data.parameters : [];
      setSprayParams(params);
      setEditedSprayParams({});
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to load spray parameters.");
    } finally {
      setIsLoadingSprayParams(false);
    }
  }, [apiBaseUrl, sprayApiUrl]);

  useEffect(() => {
    loadSprayParams();
  }, [loadSprayParams]);

  // --- v2 spray params state (used by fetchSprayParams / handleSaveParams) ---
  type SprayParam = {
    name: string;
    type: string;
    default: any;
    current: any;
    group: string;
    desc: string;
    min?: number;
    max?: number;
  };
  const [paramEdits, setParamEdits] = useState<Record<string, string>>({});
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [paramsSaving, setParamsSaving] = useState(false);
  const [paramsSaveStatus, setParamsSaveStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  // --- Manual Hold State ---
  const [manualHoldActive, setManualHoldActive] = useState(false);
  const manualHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Status polling
  useEffect(() => {
    if (!apiBaseUrl) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(sprayApiUrl("/api/spray/status"));
        if (res.ok) {
          const data = await res.json();
          const active = !!(data.spraying || data.manual_override || data.spray_active_desired);
          setSprayStatus(active);
          setIsSprayHoldActive(active);
        }
      } catch (err) {
        // ignore network errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [apiBaseUrl, sprayApiUrl]);

  // Fetch spray params on mount
  useEffect(() => {
    if (!apiBaseUrl) return;
    fetchSprayParams();
  }, [apiBaseUrl]);

  const fetchSprayParams = async () => {
    if (!apiBaseUrl) return;
    setParamsLoading(true);
    setParamsError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/spray/params`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // data may be { parameters: { key: { type, default, current, group, desc, min, max } } }
      const raw: Record<string, any> = data.parameters ?? data;
      const parsed: SprayParam[] = Object.entries(raw).map(([name, meta]: [string, any]) => ({
        name,
        type: meta.type ?? 'string',
        default: meta.default,
        current: meta.current,
        group: meta.group ?? '',
        desc: meta.desc ?? meta.description ?? '',
        min: meta.min,
        max: meta.max,
      }));
      setSprayParams(parsed);
      // Seed edits with current values
      const seeds: Record<string, string> = {};
      parsed.forEach(p => { seeds[p.name] = String(p.current ?? p.default ?? ''); });
      setParamEdits(seeds);
    } catch (err: any) {
      setParamsError(err.message ?? 'Failed to fetch params');
    } finally {
      setParamsLoading(false);
    }
  };

  const handleSaveParams = async () => {
    if (!apiBaseUrl) return;
    setParamsSaving(true);
    setParamsSaveStatus('idle');
    try {
      // Cast values to correct types
      const payload: Record<string, any> = {};
      sprayParams.forEach(p => {
        const raw = paramEdits[p.name] ?? String(p.current ?? p.default ?? '');
        if (p.type === 'bool') payload[p.name] = raw === 'true' || raw === '1';
        else if (p.type === 'int') payload[p.name] = parseInt(raw, 10);
        else if (p.type === 'float') payload[p.name] = parseFloat(raw);
        else payload[p.name] = raw;
      });
      const res = await fetch(`${apiBaseUrl}/api/spray/params`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setParamsSaveStatus('ok');
      // Refresh to get server-confirmed values
      await fetchSprayParams();
    } catch (err: any) {
      setParamsSaveStatus('err');
    } finally {
      setParamsSaving(false);
      setTimeout(() => setParamsSaveStatus('idle'), 3000);
    }
  };

  // Manual spray hold helpers
  const startManualHold = async () => {
    if (!apiBaseUrl || manualHoldActive || manualHeartbeatRef.current) return;
    try {
      await fetch(`${apiBaseUrl}/api/spray/on`, { method: 'POST' });
      setManualHoldActive(true);
      if (manualHeartbeatRef.current) clearInterval(manualHeartbeatRef.current);
      // Send a heartbeat every 7 s to keep the 8 s window alive
      manualHeartbeatRef.current = setInterval(async () => {
        try { await fetch(`${apiBaseUrl}/api/spray/on`, { method: 'POST' }); } catch (_) { }
      }, 7000);
    } catch (err) {
      console.log('Spray ON failed', err);
    }
  };

  const stopManualHold = async () => {
    if (!apiBaseUrl) return;
    if (manualHeartbeatRef.current) {
      clearInterval(manualHeartbeatRef.current);
      manualHeartbeatRef.current = null;
    }
    try {
      await fetch(`${apiBaseUrl}/api/spray/off`, { method: 'POST' });
    } catch (err) {
      console.log('Spray OFF failed', err);
    }
    setManualHoldActive(false);
  };

  // Cleanup heartbeat on unmount
  useEffect(() => {
    return () => {
      if (manualHeartbeatRef.current) clearInterval(manualHeartbeatRef.current);
    };
  }, []);

  const handleSprayToggle = async () => {
    if (!apiBaseUrl) return;
    const isTurningOn = !isTestActive;
    try {
      const res = await fetch(sprayApiUrl("/api/spray/test"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          on: isTurningOn,
          duration_s: isTurningOn ? Number(sprayDuration) || 2 : 0
        })
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to run spray test.");
        return;
      }
      setIsTestActive(isTurningOn);
      if (isTurningOn) {
        // automatically reset button state after duration
        setTimeout(() => setIsTestActive(false), (Number(sprayDuration) || 2) * 1000);
      }
    } catch (err) {
      console.log("Spray test failed", err);
    }
  };

  const handleSprayParamEdit = (name: string, value: string, current: unknown) => {
    setEditedSprayParams((prev) => {
      const next = { ...prev };
      if (value === formatSprayParamValue(current)) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  const handleSetSprayVariables = async () => {
    if (!apiBaseUrl) return;
    const editedEntries = Object.entries(editedSprayParams);
    if (editedEntries.length === 0) return;

    const paramsByName = new Map(sprayParams.map((param) => [param.name, param]));
    const payloadParams: Record<string, SprayParamPayloadValue> = {};

    try {
      for (const [name, rawValue] of editedEntries) {
        const param = paramsByName.get(name);
        if (!param) continue;
        payloadParams[name] = parseSprayParamInput(rawValue, param);
      }
    } catch (err: any) {
      Alert.alert("Invalid Value", err.message || "Check the edited spray parameter values.");
      return;
    }

    if (Object.keys(payloadParams).length === 0) return;

    setIsSavingSprayParams(true);
    try {
      const res = await fetch(sprayApiUrl("/api/spray/params"), {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ parameters: payloadParams }),
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to set spray variables.");
        return;
      }
      Alert.alert("Success", "Spray variables updated.");
      await loadSprayParams();
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend.");
    } finally {
      setIsSavingSprayParams(false);
    }
  };
  const handleSprayHoldToggle = async () => {
    if (!apiBaseUrl) return;
    const nextHoldActive = !isSprayHoldActive;
    setIsSprayHoldChanging(true);
    try {
      const res = await fetch(sprayApiUrl(nextHoldActive ? "/api/spray/on" : "/api/spray/off"), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to turn spray ${nextHoldActive ? "on" : "off"}.`);
        return;
      }
      setIsSprayHoldActive(nextHoldActive);
      setSprayStatus(nextHoldActive);
      if (!nextHoldActive) setIsTestActive(false);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend.");
    } finally {
      setIsSprayHoldChanging(false);
    }
  };

  const hasEditedSprayParams = Object.keys(editedSprayParams).length > 0;

  return (
    <ScrollView style={{ flex: 1, padding: 18 }}>

      <Text style={secH}>Cart</Text>
      <Text style={itemH}>Configured Machine</Text>
      <Text style={itemT}>Not Configured</Text>
      <Text style={itemT}>Searching</Text>
      <Text style={secH}>Pump</Text>
      <Text style={itemH}>Manual Control</Text>
      <Text style={itemT}>Disconnected</Text>

      <View
        style={{
          marginTop: 14,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: "#cbd5e1",
          borderRadius: 8,
          backgroundColor: "#f8fafc",
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 16 }}>
            <Text style={{ color: "#334155", fontSize: 16, fontWeight: "700" }}>Enable Floating E-Stop</Text>
            <Text style={{ color: "#64748b", fontSize: 12, marginTop: 4, lineHeight: 16 }}>
              Persistent double-tap emergency shortcut for rover screens.
            </Text>
          </View>
          <Switch
            value={isFloatingEStopEnabled}
            onValueChange={setIsFloatingEStopEnabled}
            trackColor={{ false: "#cbd5e1", true: "#dc2626" }}
            thumbColor="#ffffff"
          />
        </View>
      </View>

      {/* Spray Test Section */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 12 }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
          <Text style={{ color: "#334155", fontSize: 16, fontWeight: "600", marginRight: 12 }}>Spray Test</Text>
          {sprayStatus && (
            <View style={{ backgroundColor: "#22c55e", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 }}>
              <Text style={{ color: "#fff", fontSize: 10, fontWeight: "bold" }}>SPRAYING</Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <TextInput
            value={sprayDuration}
            onChangeText={setSprayDuration}
            keyboardType="numeric"
            placeholder="sec"
            style={{
              borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8,
              width: 60, paddingHorizontal: 10, paddingVertical: 8,
              marginRight: 10, color: "#334155", textAlign: "center"
            }}
          />
          <Pressable
            onPress={handleSprayToggle}
            style={{
              backgroundColor: isTestActive ? "#ef4444" : "#0ea5e9",
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 8
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>{isTestActive ? "Stop" : "Start"}</Text>
          </Pressable>
          <Pressable
            onPress={handleSprayHoldToggle}
            disabled={isSprayHoldChanging}
            style={{
              backgroundColor: isSprayHoldChanging ? "#94a3b8" : isSprayHoldActive ? "#ef4444" : "#0f766e",
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 8,
              marginLeft: 10,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>
              {isSprayHoldChanging ? "..." : isSprayHoldActive ? "Spray Off" : "Spray On"}
            </Text>
          </Pressable>
          <Pressable
            onPressIn={startManualHold}
            onPressOut={stopManualHold}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => ({
              marginLeft: 14,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: manualHoldActive ? "#10b981" : "#0f766e", fontWeight: "700", textDecorationLine: "underline" }}>
              {manualHoldActive ? "SPRAYING..." : "Hold to Spray"}
            </Text>
          </Pressable>
        </View>
      </View>
      {manualHoldActive && (
        <View style={{ backgroundColor: '#dcfce7', borderRadius: 8, padding: 8, marginBottom: 12 }}>
          <Text style={{ color: '#15803d', fontSize: 12, textAlign: 'center', fontWeight: '600' }}>● Manual spray active — heartbeat running</Text>
        </View>
      )}

      <View style={{ marginTop: 4, marginBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Text style={itemH}>Spray Controller Params</Text>
          {hasEditedSprayParams && (
            <Pressable
              onPress={handleSetSprayVariables}
              disabled={isSavingSprayParams}
              style={{
                backgroundColor: isSavingSprayParams ? "#94a3b8" : "#0f988f",
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>
                {isSavingSprayParams ? "Saving..." : "Set Variables"}
              </Text>
            </Pressable>
          )}
        </View>
        {isLoadingSprayParams ? (
          <View style={{ paddingVertical: 16, alignItems: "center" }}>
            <ActivityIndicator color="#0f988f" />
          </View>
        ) : sprayParams.length === 0 ? (
          <Text style={{ color: "#64748b", fontSize: 13 }}>No spray parameters loaded.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, overflow: "hidden" }}>
              <View style={{ flexDirection: "row", backgroundColor: "#f1f5f9" }}>
                {["Name", "Group", "Type", "Current", "Default", "Min", "Max", "Description"].map((heading) => (
                  <Text key={heading} style={sprayParamTableHeaderStyle}>{heading}</Text>
                ))}
              </View>
              {sprayParams.map((param, index) => {
                const editedValue = editedSprayParams[param.name];
                return (
                  <View
                    key={param.name}
                    style={{
                      flexDirection: "row",
                      backgroundColor: index % 2 === 0 ? "#fff" : "#f8fafc",
                      borderTopWidth: 1,
                      borderTopColor: "#e2e8f0",
                    }}
                  >
                    <Text style={sprayParamTableTextCellStyle}>{param.name}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.group)}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.type)}</Text>
                    <View style={sprayParamTableInputCellStyle}>
                      <TextInput
                        value={editedValue ?? formatSprayParamValue(param.current)}
                        onChangeText={(value) => handleSprayParamEdit(param.name, value, param.current)}
                        keyboardType={isNumericSprayParam(param) ? "numeric" : "default"}
                        autoCapitalize="none"
                        style={{
                          minWidth: 92,
                          borderWidth: 1,
                          borderColor: editedValue == null ? "#cbd5e1" : "#0f988f",
                          borderRadius: 6,
                          paddingHorizontal: 8,
                          paddingVertical: 6,
                          color: "#0f172a",
                          fontSize: 12,
                        }}
                      />
                    </View>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.default)}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.min)}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.max)}</Text>
                    <Text style={[sprayParamTableTextCellStyle, { width: 220 }]}>{formatSprayParamValue(param.description)}</Text>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>

      <RowToggle label="Manual Painting with Long Press" value={toggleA} onChange={setToggleA} />
      <RowToggle label="Paint When Reversing" value={toggleB} onChange={setToggleB} />
      <RowSlider label="Pump Start Delay [s]" value={delayA} onChange={setDelayA} />
      <RowSlider label="Pump Stop Delay [s]" value={delayB} onChange={setDelayB} />
      <Text style={secH}>Paint Rate</Text>
      <Text style={itemT}>Slowest Rate 100%</Text>
      <Text style={itemT}>Fastest Rate 100%</Text>
      <Text style={secH}>Arm Control</Text>
      <Text style={itemH}>Manual Control</Text>
      <Text style={itemT}>Disconnected</Text>
      <Text style={secH}>Dimensions</Text>
      <Text style={itemH}>Offset Sideways</Text>
      <Text style={itemT}>0.085m</Text>
      <Text style={itemH}>Offset Front</Text>
      <Text style={itemT}>0m</Text>
      <Text style={itemH}>Offset Up</Text>
      <Text style={itemT}>0.5m</Text>
      <Text style={itemH}>Mow Deck Cut Width</Text>
      <Text style={itemT}>1m</Text>
    </ScrollView>
  );
}

export function StatusPage() {
  return (
    <ScrollView style={{ flex: 1, padding: 12 }}>
      <Text style={itemT}>Tablet not connected to a machine.</Text>
      <Text style={[itemT, { marginTop: 26 }]}>Searching for a machine to connect to.</Text>
      <Text style={[itemT, { marginTop: 26 }]}>Tablet not connected to a machine.</Text>
      <View style={{ marginTop: 26 }}>
        <Text style={itemH}>Current Status:</Text>
        <Text style={itemT}>Tablet App not connected to the machine.</Text>
        <Text style={itemH}>To Proceed:</Text>
        <Text style={[itemT, { fontWeight: "700" }]}>Ensure the tablet is configured and the machine is turned on.</Text>
        <Text style={itemH}>Next Status:</Text>
        <Text style={[itemT, { fontStyle: "italic" }]}>Connected to the machine.</Text>
      </View>
      <Text style={secH}>Field Category</Text>
      {[
        "Football (Soccer)",
        "Rugby",
        "North American Football (Gridiron)",
        "Running Tracks - Grass",
        "Athletics",
        "Ball and Net Sports",
        "Racquet, Bat and Stick Sports",
        "Miscellaneous Fields",
      ].map((x) => (
        <Text key={x} style={itemT}>🔒 {x}</Text>
      ))}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}

export function PositioningPage({
  toggleA,
  toggleB,
  toggleC,
  toggleD,
  setToggleA,
  setToggleB,
  setToggleC,
  setToggleD,
}: {
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  toggleD: boolean;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  setToggleD: (v: boolean) => void;
}) {
  return (
    <ScrollView style={{ flex: 1, padding: 18 }}>
      <Text style={secH}>Position</Text>
      <RowToggle label="Position Smoothing" value={toggleC} onChange={setToggleC} />
      <RowToggle label="Disable Position Snap with Long Press" value={toggleD} onChange={setToggleD} />
      <RowToggle label="Position Jump Detection" value={toggleA} onChange={setToggleA} />
      <Text style={secH}>Source</Text>
      <Text style={itemT}>◯ GPS</Text>
      <Text style={itemT}>◯ Local Laser Tracker</Text>
      <Text style={secH}>Terrain Correction</Text>
      <Text style={itemT}>Roll</Text>
      <RowToggle label="Terrain Correction" value={toggleA} onChange={setToggleA} />
      <RowToggle label="3D Terrain Correction (Beta)" value={toggleB} onChange={setToggleB} />
      <RowToggle label="3D Terrain Correction Prompts" value={toggleC} onChange={setToggleC} />
    </ScrollView>
  );
}

export function SettingsPage(props: {
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  rtkCaster?: string;
  setRtkCaster?: React.Dispatch<React.SetStateAction<string>>;
  rtkPort?: string;
  setRtkPort?: React.Dispatch<React.SetStateAction<string>>;
  rtkMountPoint?: string;
  setRtkMountPoint?: React.Dispatch<React.SetStateAction<string>>;
  rtkUsername?: string;
  setRtkUsername?: React.Dispatch<React.SetStateAction<string>>;
  rtkPassword?: string;
  setRtkPassword?: React.Dispatch<React.SetStateAction<string>>;
  rtkRunning?: boolean;
  rtkHealthy?: boolean;
  rtkMode?: string;
  rtkDefaultMode?: string;
  setRtkDefaultMode?: React.Dispatch<React.SetStateAction<string>>;
  rtkAutoConnect?: boolean;
  setRtkAutoConnect?: React.Dispatch<React.SetStateAction<boolean>>;
  stopRtk?: () => Promise<void>;
  apiBaseUrl?: string;
  selectedPathName?: string | null;
}) {
  return (
    <Suspense fallback={<ActivityIndicator />}>
      <ModernSettingsPage {...props} />
    </Suspense>
  );
}

export function HowToPage() {
  const items = [
    "Videos",
    "System Basics",
    "How to create a sports field",
    "How to reference the system",
    "How to change a sports field",
    "How to manually operate the pump or arm?",
    "How does the SWOZI terrain correction work? (Beta)",
  ];
  return (
    <ScrollView style={{ flex: 1, padding: 14 }} contentContainerStyle={{ gap: 8, paddingBottom: 20 }}>
      <Text style={{ fontSize: 18, color: "#f8fafc", fontWeight: "800", marginBottom: 4 }}>
        How to
      </Text>
      <Text style={{ fontSize: 12, color: "#94a3b8", fontWeight: "500", marginBottom: 8 }}>
        SWOZI knowledge base
      </Text>
      {items.map((x) => (
        <View
          key={x}
          style={{
            minHeight: 44,
            backgroundColor: "#1f1f24",
            borderWidth: 1,
            borderColor: "#2e2e34",
            borderRadius: 10,
            justifyContent: "center",
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text style={{ fontSize: 13, color: "#f8fafc", fontWeight: "600" }}>{x}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

export function AboutPage() {
  return (
    <ScrollView style={{ flex: 1 }}>
      <View style={{ height: 52, backgroundColor: "#bcbdbf", flexDirection: "row" }}>
        {["TERMS", "OPEN SOURCE", "PRIVACY", "VERSION"].map((t, i) => (
          <View key={t} style={{ flex: 1, backgroundColor: i === 0 ? "#efefef" : "#bcbdbf", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 28 / 2, color: "#222" }}>{t}</Text>
          </View>
        ))}
      </View>
      <View style={{ padding: 10 }}>
        <Text style={{ fontSize: 62 / 2, color: "#2e2f31", marginBottom: 8 }}>SWOZI AG Terms of Service</Text>
        <Text style={itemT}>Last modified: November 1, 2016</Text>
        <Text style={[itemH, { marginTop: 12 }]}>Using our Services</Text>
        <Text style={itemT}>
          You must follow any policies made available to you within the Services.
        </Text>
        <Text style={[itemH, { marginTop: 12 }]}>Privacy and Copyright Protection</Text>
        <Text style={itemT}>SWOZI Privacy Policy explain how we treat your personal data.</Text>
      </View>
    </ScrollView>
  );
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ color: "#0f172a", fontWeight: "700" }}>{label}</Text>
      <Text style={{ color: "#0f172a", flexShrink: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

export function lineLength(line: PlanLine) {
  return Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
}

export function lineAngle(line: PlanLine) {
  return (Math.atan2(line.to.y - line.from.y, line.to.x - line.from.x) * 180) / Math.PI;
}

export function buildRectangleTemplate(name: string, width: number, height: number): PlanLine[] {
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const cx = x0 + width / 2;

  return [
    {
      id: `${name}-top`,
      label: `${name} Top`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x0, y: y0 },
      to: { id: nextGeneratedPointId(), x: x1, y: y0 },
      width: 0.1,
    },
    {
      id: `${name}-right`,
      label: `${name} Right`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x1, y: y0 },
      to: { id: nextGeneratedPointId(), x: x1, y: y1 },
      width: 0.1,
    },
    {
      id: `${name}-bottom`,
      label: `${name} Bottom`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x1, y: y1 },
      to: { id: nextGeneratedPointId(), x: x0, y: y1 },
      width: 0.1,
    },
    {
      id: `${name}-left`,
      label: `${name} Left`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x0, y: y1 },
      to: { id: nextGeneratedPointId(), x: x0, y: y0 },
      width: 0.1,
    },
    {
      id: `${name}-center`,
      label: `${name} Center`,
      layer: "center",
      from: { id: nextGeneratedPointId(), x: cx, y: y0 },
      to: { id: nextGeneratedPointId(), x: cx, y: y1 },
      width: 0.08,
    },
  ];
}

export function buildTemplate(name: string, width: number, height: number): PlanLine[] {
  resetGeneratedPointIds();
  const key = name.toLowerCase();
  if (key.includes("reference sample")) return buildReferenceSampleTemplate(width, height);
  if (key.includes("football")) return buildFootballTemplate(width, height);
  if (key.includes("hockey")) return buildHockeyTemplate(width, height);
  if (key.includes("cricket")) return buildCricketPitchTemplate(width, height);
  if (key.includes("volleyball")) return buildVolleyballTemplate(width, height);
  if (key.includes("badminton")) return buildBadmintonTemplate(width, height);
  if (key.includes("kabaddi")) return buildKabaddiTemplate(width, height);
  if (key.includes("khokho")) return buildKhoKhoTemplate(width, height);
  return buildRectangleTemplate(name.toLowerCase().replace(/\s+/g, "_"), width, height);
}

function buildFootballTemplate(width: number, height: number): PlanLine[] {
  const name = "football";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  const penaltyW = 16.5;
  const penaltyH = 40.32;
  const goalW = 5.5;
  const goalH = 18.32;
  const arcRadius = 9.15;

  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-line`, "center", centerX, y0, centerX, y1, 0.1, "Center Line"),
    ...buildRect(name, "marking", x0, centerY - penaltyH / 2, x0 + penaltyW, centerY + penaltyH / 2, 0.08, "Left Penalty Box"),
    ...buildRect(name, "marking", x1 - penaltyW, centerY - penaltyH / 2, x1, centerY + penaltyH / 2, 0.08, "Right Penalty Box"),
    ...buildRect(name, "marking", x0, centerY - goalH / 2, x0 + goalW, centerY + goalH / 2, 0.08, "Left Goal Box"),
    ...buildRect(name, "marking", x1 - goalW, centerY - goalH / 2, x1, centerY + goalH / 2, 0.08, "Right Goal Box"),
    ...buildCircle(name, "center", centerX, centerY, arcRadius, 64, "Center Circle"),
    ...buildArcPolyline(x0 + penaltyW, centerY, arcRadius, 305, 55, 24, "marking", `${name}-left-penalty-arc`),
    ...buildArcPolyline(x1 - penaltyW, centerY, arcRadius, 125, 235, 24, "marking", `${name}-right-penalty-arc`),
    ...buildCornerArcs(name, x0, y0, x1, y1, 1, 12),
  ];
}

function buildHockeyTemplate(width: number, height: number): PlanLine[] {
  const name = "hockey";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  const dRadius = 14.63;
  const circleX = x0 + 22.9;
  const rightCircleX = x1 - 22.9;

  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-line`, "center", centerX, y0, centerX, y1, 0.08, "Center Line"),
    line(`${name}-left-23`, "marking", circleX, y0, circleX, y1, 0.06, "23m Line Left"),
    line(`${name}-right-23`, "marking", rightCircleX, y0, rightCircleX, y1, 0.06, "23m Line Right"),
    ...buildArcPolyline(x0 + 14.63, centerY, dRadius, 270, 90, 32, "marking", `${name}-left-d-arc-a`),
    ...buildArcPolyline(x0 + 14.63, centerY, dRadius, 90, 270, 32, "marking", `${name}-left-d-arc-b`),
    ...buildArcPolyline(x1 - 14.63, centerY, dRadius, 90, 270, 32, "marking", `${name}-right-d-arc-a`),
    ...buildArcPolyline(x1 - 14.63, centerY, dRadius, 270, 90, 32, "marking", `${name}-right-d-arc-b`),
  ];
}

function buildCricketPitchTemplate(width: number, height: number): PlanLine[] {
  const name = "cricket_pitch";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-pitch-line-a`, "center", centerX, y0, centerX, y1, 0.08, "Pitch Center"),
    line(`${name}-pitch-line-b`, "center", centerX - 1.525, y0, centerX - 1.525, y1, 0.08, "Pitch Stump Line Left"),
    line(`${name}-pitch-line-c`, "center", centerX + 1.525, y0, centerX + 1.525, y1, 0.08, "Pitch Stump Line Right"),
    ...buildArcPolyline(centerX, centerY, 27.43, 300, 60, 36, "marking", `${name}-left-ring`),
    ...buildArcPolyline(centerX, centerY, 27.43, 120, 240, 36, "marking", `${name}-right-ring`),
  ];
}

function buildVolleyballTemplate(width: number, height: number): PlanLine[] {
  const name = "volleyball";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-line`, "center", centerX, y0, centerX, y1, 0.08, "Center Line"),
    line(`${name}-attack-left`, "marking", centerX - 3, y0, centerX - 3, y1, 0.06, "Attack Line Left"),
    line(`${name}-attack-right`, "marking", centerX + 3, y0, centerX + 3, y1, 0.06, "Attack Line Right"),
  ];
}

function buildBadmintonTemplate(width: number, height: number): PlanLine[] {
  const name = "badminton";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-net`, "center", centerX, y0, centerX, y1, 0.05, "Net Line"),
    line(`${name}-short-service`, "marking", x0, y0 + 1.98, x1, y0 + 1.98, 0.05, "Short Service Line"),
    line(`${name}-long-service`, "marking", x0, y1 - 0.76, x1, y1 - 0.76, 0.05, "Long Service Line Doubles"),
    line(`${name}-singles-left`, "marking", x0 + 0.46, y0, x0 + 0.46, y1, 0.04, "Singles Sideline Left"),
    line(`${name}-singles-right`, "marking", x1 - 0.46, y0, x1 - 0.46, y1, 0.04, "Singles Sideline Right"),
  ];
}

function buildKabaddiTemplate(width: number, height: number): PlanLine[] {
  const name = "kabaddi";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerY = y0 + height / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-halfway`, "center", x0, centerY, x1, centerY, 0.08, "Halfway Line"),
    line(`${name}-baulk-a`, "marking", x0, centerY - 3.75, x1, centerY - 3.75, 0.06, "Baulk Line A"),
    line(`${name}-baulk-b`, "marking", x0, centerY + 3.75, x1, centerY + 3.75, 0.06, "Baulk Line B"),
    line(`${name}-bonus-a`, "marking", x0, y0 + 1.75, x1, y0 + 1.75, 0.06, "Bonus Line A"),
    line(`${name}-bonus-b`, "marking", x0, y1 - 1.75, x1, y1 - 1.75, 0.06, "Bonus Line B"),
  ];
}

function buildKhoKhoTemplate(width: number, height: number): PlanLine[] {
  const name = "khokho";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  const laneGap = 2.3;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-central-lane`, "center", centerX, y0 + 1.5, centerX, y1 - 1.5, 0.08, "Central Lane"),
    ...Array.from({ length: 8 }, (_, i) => {
      const offset = y0 + 2.55 + laneGap * i;
      return line(`${name}-cross-${i + 1}`, "marking", x0, offset, x1, offset, 0.05, `Cross Lane ${i + 1}`);
    }),
  ];
}

function buildArcPolyline(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  segments: number,
  layer: PlanLine["layer"],
  prefix: string
): PlanLine[] {
  const points: Array<{ x: number; y: number }> = [];
  const sweep = endAngle >= startAngle ? endAngle - startAngle : endAngle + 360 - startAngle;
  for (let i = 0; i <= segments; i += 1) {
    const angle = startAngle + (sweep * i) / segments;
    const rad = (angle * Math.PI) / 180;
    points.push({ x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) });
  }
  const lines: PlanLine[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    lines.push({
      id: `${prefix}-${i}`,
      label: `${prefix} segment ${i + 1}`,
      layer,
      from: { id: nextGeneratedPointId(), x: points[i].x, y: points[i].y },
      to: { id: nextGeneratedPointId(), x: points[i + 1].x, y: points[i + 1].y },
      width: layer === "boundary" ? 0.12 : 0.08,
    });
  }
  return lines;
}

function buildCircle(
  name: string,
  layer: PlanLine["layer"],
  cx: number,
  cy: number,
  radius: number,
  segments: number,
  label: string
) {
  return buildArcPolyline(cx, cy, radius, 0, 360, segments, layer, `${name}-${label.replace(/\s+/g, "-").toLowerCase()}`);
}

function buildRect(
  name: string,
  layer: PlanLine["layer"],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  label: string
) {
  return [
    line(`${name}-${label}-top`, layer, x0, y0, x1, y0, width, `${label} Top`),
    line(`${name}-${label}-right`, layer, x1, y0, x1, y1, width, `${label} Right`),
    line(`${name}-${label}-bottom`, layer, x1, y1, x0, y1, width, `${label} Bottom`),
    line(`${name}-${label}-left`, layer, x0, y1, x0, y0, width, `${label} Left`),
  ];
}

function buildCornerArcs(name: string, x0: number, y0: number, x1: number, y1: number, radius: number, segments = 12) {
  return [
    ...buildArcPolyline(x0, y0, radius, 180, 270, segments, "marking", `${name}-corner-nw`),
    ...buildArcPolyline(x1, y0, radius, 270, 360, segments, "marking", `${name}-corner-ne`),
    ...buildArcPolyline(x1, y1, radius, 0, 90, segments, "marking", `${name}-corner-se`),
    ...buildArcPolyline(x0, y1, radius, 90, 180, segments, "marking", `${name}-corner-sw`),
  ];
}

function buildReferenceSampleTemplate(width: number, height: number): PlanLine[] {
  const x0 = 12;
  const y0 = 10;
  const x1 = 88;
  const y1 = 50;
  const centerX = (x0 + x1) / 2;
  const penaltyW = 14;
  const penaltyH = 24;

  return [
    line("ref-top", "boundary", x0, y0, x1, y0, 0.12, "Touchline North"),
    line("ref-right", "boundary", x1, y0, x1, y1, 0.12, "Goal Line East"),
    line("ref-bottom", "boundary", x1, y1, x0, y1, 0.12, "Touchline South"),
    line("ref-left", "boundary", x0, y1, x0, y0, 0.12, "Goal Line West"),
    line("ref-center", "center", centerX, y0, centerX, y1, 0.1, "Center Split"),
    line("ref-center-guide", "center", centerX - 10, (y0 + y1) / 2, centerX + 10, (y0 + y1) / 2, 0.08, "Center Guide"),
    ...buildRect("ref-left-box", "marking", x0, y0 + 8, x0 + penaltyW, y0 + 32, 0.1, "Penalty Box West"),
    ...buildRect("ref-right-box", "marking", x1 - penaltyW, y0 + 8, x1, y0 + 32, 0.1, "Penalty Box East"),
  ];
}

function line(
  id: string,
  layer: PlanLine["layer"],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  label: string
): PlanLine {
  return {
    id,
    label,
    layer,
    from: { id: nextGeneratedPointId(), x: x1, y: y1 },
    to: { id: nextGeneratedPointId(), x: x2, y: y2 },
    width,
  };
}

let generatedPointIdCounter = 1;

function resetGeneratedPointIds() {
  generatedPointIdCounter = 1;
}

function nextGeneratedPointId() {
  return generatedPointIdCounter++;
}

export function defaultDimensions(name: string) {
  const key = name.toLowerCase();
  if (key.includes("volleyball")) return { width: 18, height: 9 };
  if (key.includes("badminton")) return { width: 13.4, height: 6.1 };
  if (key.includes("kabaddi")) return { width: 13, height: 10 };
  if (key.includes("khokho")) return { width: 27, height: 16 };
  if (key.includes("hockey")) return { width: 91.4, height: 55 };
  if (key.includes("cricket")) return { width: 20.12, height: 3.05 };
  return { width: 100, height: 64 };
}

const inputStyle = {
  borderWidth: 1,
  borderColor: "#cbd5e1",
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
  color: "#111",
} as const;

const generatorStyles = {
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.22)",
    justifyContent: "center",
    padding: 18,
  },
  sheet: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#d7dee8",
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 14,
  },
  sheetTitle: {
    color: "#0f172a",
    fontSize: 22,
    fontWeight: "800",
  },
  sheetSubtitle: {
    color: "#64748b",
    marginTop: 4,
    lineHeight: 20,
  },
  closePill: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#d7dee8",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafc",
  },
  closeText: {
    color: "#0f172a",
    fontSize: 22,
    lineHeight: 22,
    marginTop: -2,
  },
  toggleRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  toggleChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#d7dee8",
  },
  toggleChipActive: {
    backgroundColor: "#0f172a",
    borderColor: "#0f172a",
  },
  toggleChipText: {
    color: "#334155",
    fontWeight: "700",
  },
  toggleChipTextActive: {
    color: "#fff",
  },
  presetGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  presetCard: {
    width: "48.5%",
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d7dee8",
    backgroundColor: "#f8fafc",
  },
  presetCardActive: {
    borderColor: "#0f172a",
    backgroundColor: "#eef2f7",
  },
  presetTitle: {
    color: "#0f172a",
    fontWeight: "700",
    fontSize: 15,
  },
  presetTitleActive: {},
  presetMeta: {
    color: "#64748b",
    marginTop: 4,
    fontSize: 12,
  },
  presetMetaActive: {},
  inputRow: {
    flexDirection: "row",
    gap: 12,
  },
  inputLabel: {
    color: "#334155",
    fontWeight: "700",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#f8fafc",
    color: "#0f172a",
  },
  generateButton: {
    marginTop: 16,
    backgroundColor: "#0f172a",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  generateButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 15,
  },
} as const;

export function linesToDxf(lines: PlanLine[], name: string) {
  // Exclude virtual_boundary lines — they are UI-only alignment aids
  const filteredLines = lines.filter((line) => line.layer !== "virtual_boundary");
  const layers = Array.from(new Set(filteredLines.map((line) => line.layer.toUpperCase())));
  const layerTable = layers
    .map((layer) => [
      "0",
      "LAYER",
      "2",
      layer,
      "70",
      "0",
      "62",
      layer === "BOUNDARY" ? "7" : layer === "CENTER" ? "3" : "4",
      "6",
      "CONTINUOUS",
    ].join("\n"))
    .join("\n");

  const entities = filteredLines
    .map((entry) => [
      "0",
      "LINE",
      "8",
      entry.layer.toUpperCase(),
      "370",
      String(mmLineweight(entry.width)),
      "10",
      String(entry.from.y),
      "20",
      String(entry.from.x),
      "11",
      String(entry.to.y),
      "21",
      String(entry.to.x),
    ].join("\n"))
    .join("\n");

  return [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$INSUNITS",
    "70",
    "6",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "TABLES",
    "0",
    "TABLE",
    "2",
    "LAYER",
    "70",
    String(layers.length),
    layerTable,
    "0",
    "ENDTAB",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
    entities,
    "0",
    "ENDSEC",
    "0",
    "EOF",
  ].join("\n");
}

export function mmLineweight(widthMeters: number) {
  const mm = Math.round(widthMeters * 1000);
  if (mm <= 0) return -1;
  return Math.min(211, Math.max(0, mm));
}

export function RowToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
      <Text style={itemT}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: "#cfd0d2", true: "#95d4cc" }} thumbColor={value ? TEAL : "#e3e3e3"} />
    </View>
  );
}

export function RowSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={itemH}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Slider minimumValue={0} maximumValue={1} value={value} onValueChange={onChange} minimumTrackTintColor={TEAL} maximumTrackTintColor="#bfc0c3" />
        </View>
        <Text style={itemT}>{value.toFixed(2)}s</Text>
      </View>
    </View>
  );
}

const secH = { fontSize: 66 / 2, color: "#515254", fontWeight: "700", marginTop: 10 } as const;
const itemH = { fontSize: 50 / 2, color: "#55565a", fontWeight: "700", marginTop: 8 } as const;
const itemT = { fontSize: 46 / 2, color: "#616266", marginTop: 4 } as const;

