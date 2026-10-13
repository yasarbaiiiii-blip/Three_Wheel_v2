import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
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
import type { RTKStatus } from "../types/appRuntime";
import { useSprayState } from "../features/telemetry/prodTelemetryStore";

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
  const [, setParamEdits] = useState<Record<string, string>>({});
  const [, setParamsLoading] = useState(false);
  const [, setParamsError] = useState<string | null>(null);
  // --- Manual Hold State ---
  const [manualHoldActive, setManualHoldActive] = useState(false);
  const manualHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Status via telemetry events (no polling)
  const sprayState = useSprayState();
  useEffect(() => {
    if (!sprayState.known) {
      setSprayStatus(false);
      if (!isSprayHoldChanging) setIsSprayHoldActive(false);
      return;
    }
    setSprayStatus(sprayState.active);
    if (!isSprayHoldChanging) {
      setIsSprayHoldActive(sprayState.manualActive);
    }
  }, [sprayState, isSprayHoldChanging]);

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

/** Pull the Settings chunk in ahead of the first visit (see App's idle preload). */
export function preloadSettingsPage(): Promise<unknown> {
  return import("../components/ModernSettingsPage");
}

export function SettingsPage(props: {
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  rtkStatus?: RTKStatus;
  stopRtk?: () => Promise<void>;
  apiBaseUrl?: string;
  dashPattern?: import("../utils/appPlannedMissionBuilder").DashPattern | null;
  onDashPatternChange?: (pattern: import("../utils/appPlannedMissionBuilder").DashPattern | null) => void;
}) {
  return (
    <Suspense fallback={<ActivityIndicator />}>
      <ModernSettingsPage
        rtkStatus={props.rtkStatus}
        stopRtk={props.stopRtk}
        toggleA={props.toggleA}
        toggleB={props.toggleB}
        toggleC={props.toggleC}
        setToggleA={props.setToggleA}
        setToggleB={props.setToggleB}
        setToggleC={props.setToggleC}
        apiBaseUrl={props.apiBaseUrl}
        dashPattern={props.dashPattern}
        onDashPatternChange={props.onDashPatternChange}
      />
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

