import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  Switch,
  Alert,
  useWindowDimensions,
  Platform,
  ActivityIndicator,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import {
  Settings,
  Droplets,
  Check,
  Upload,
  FileText,
  Play,
  Power,
  Radio,
  Satellite,
  Lock,
  Globe,
} from "lucide-react-native";

const COLORS = {
  bgBase: "#09090b",
  panelSolid: "#18181b",
  cardSolid: "#1f1f24",
  surfaceSolid: "#252529",
  panelBorder: "#2e2e34",
  textMain: "#f8fafc",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accentBrand: "#f4c10c",
  accentText: "#1c1c1c",
  accentMuted: "#2e2a18",
  accentBorder: "#6b5a12",
  success: "#10b981",
  successMuted: "#143d30",
  successBorder: "#1f6b4f",
  danger: "#ef4444",
  dangerMuted: "#3d1818",
  dangerBorder: "#7f2a2a",
  warning: "#f59e0b",
  warningMuted: "#3d2e14",
  warningBorder: "#7a5a12",
  info: "#38bdf8",
  infoMuted: "#142c3d",
  infoBorder: "#1f5a7a",
};

const SHADOWS = {
  panel: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 10,
  },
};

type SprayMode = "continuous" | "dashed" | "point";

type ModernSettingsPageProps = {
  rtkCaster?: string;
  setRtkCaster?: (v: string) => void;
  rtkPort?: string;
  setRtkPort?: (v: string) => void;
  rtkMountPoint?: string;
  setRtkMountPoint?: (v: string) => void;
  rtkUsername?: string;
  setRtkUsername?: (v: string) => void;
  rtkPassword?: string;
  setRtkPassword?: (v: string) => void;
  rtkRunning?: boolean;
  rtkHealthy?: boolean;
  rtkMode?: string;
  setRtkDefaultMode?: (mode: string) => void;
  toggleA?: boolean;
  toggleB?: boolean;
  toggleC?: boolean;
  setToggleA?: (v: boolean) => void;
  setToggleB?: (v: boolean) => void;
  setToggleC?: (v: boolean) => void;
  apiBaseUrl?: string;
  selectedPathName?: string | null;
};

const parseRtkTxt = (content: string) => {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^:=]+)[:=](.*)$/);
    if (!match) continue;

    const key = match[1].trim().toLowerCase();
    const val = match[2].trim();

    if (key === "host" || key === "caster" || key === "caster host") result.caster = val;
    else if (key === "port") result.port = val;
    else if (key === "mountpoint" || key === "mount point") result.mountPoint = val;
    else if (key === "username" || key === "user") result.username = val;
    else if (key === "password" || key === "pass") result.password = val;
  }

  return result;
};

const SettingsPanel = ({
  icon: Icon,
  title,
  subtitle,
  children,
  headerAction,
}: {
  icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  headerAction?: React.ReactNode;
}) => (
  <View style={styles.panel}>
    <View style={styles.panelHeader}>
      <View style={styles.panelHeaderLeft}>
        <View style={styles.panelIconWrap}>
          <Icon color={COLORS.accentBrand} size={18} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.panelTitle}>{title}</Text>
          {subtitle ? <Text style={styles.panelSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      {headerAction}
    </View>
    <View style={styles.panelBody}>{children}</View>
  </View>
);

const SettingsField = ({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "numeric";
  editable?: boolean;
}) => (
  <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput
      style={[styles.input, !editable && styles.inputDisabled]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={COLORS.textDim}
      secureTextEntry={secureTextEntry}
      keyboardType={keyboardType}
      editable={editable}
      autoCapitalize="none"
      autoCorrect={false}
    />
  </View>
);

const SettingsToggle = ({
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) => (
  <View style={[styles.toggleRow, disabled && styles.toggleRowDisabled]}>
    <View style={{ flex: 1 }}>
      <Text style={styles.toggleLabel}>{label}</Text>
      {hint ? <Text style={styles.toggleHint}>{hint}</Text> : null}
    </View>
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ false: COLORS.surfaceSolid, true: COLORS.accentBrand }}
      thumbColor={value ? COLORS.accentText : COLORS.textMuted}
    />
  </View>
);

const RtkStatusStrip = ({
  running,
  healthy,
  mode,
  fieldsLocked = false,
}: {
  running: boolean;
  healthy: boolean;
  mode: string;
  fieldsLocked?: boolean;
}) => {
  const tone = running ? (healthy ? COLORS.success : COLORS.warning) : COLORS.textDim;
  const barLevels = running ? (healthy ? [1, 1, 1, 1] : [1, 1, 0.35, 0.2]) : [0.15, 0.15, 0.15, 0.15];
  const barHeights = [5, 8, 11, 14];
  const modeLabel = mode === "lora" ? "LoRa" : mode === "ntrip" ? "NTRIP" : null;
  const statusLine = running
    ? (healthy ? "Connected" : "Weak signal")
    : "Not connected";

  const statusText = [
    statusLine,
    modeLabel && running ? modeLabel : null,
    fieldsLocked ? "Stop RTK to edit" : null,
  ].filter(Boolean).join(" · ");

  return (
    <View style={[styles.rtkStatusStrip, running && (healthy ? styles.rtkStatusLive : styles.rtkStatusWarn)]}>
      <View style={styles.rtkBars}>
        {barHeights.map((h, i) => (
          <View
            key={i}
            style={[styles.rtkBar, { height: h, backgroundColor: tone, opacity: barLevels[i] }]}
          />
        ))}
      </View>
      {running ? <View style={[styles.liveDot, { backgroundColor: tone }]} /> : null}
      {fieldsLocked ? <Lock color={COLORS.warning} size={12} strokeWidth={2.2} /> : null}
      <Text
        style={[styles.rtkStatusLine, { color: running ? tone : COLORS.textDim }]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {statusText}
      </Text>
    </View>
  );
};

const RtkModeToggle = ({
  value,
  onChange,
}: {
  value: "NTRIP" | "Lora";
  onChange: (mode: "NTRIP" | "Lora") => void;
}) => {
  const isNtrip = value === "NTRIP";

  return (
    <View style={styles.rtkToggleTrack}>
      <Pressable
        style={[styles.rtkToggleOption, isNtrip && styles.rtkToggleOptionActive]}
        onPress={() => onChange("NTRIP")}
      >
        <Globe color={isNtrip ? COLORS.accentText : COLORS.textMuted} size={13} strokeWidth={2.2} />
        <Text style={[styles.rtkToggleText, isNtrip && styles.rtkToggleTextActive]}>NTRIP</Text>
      </Pressable>
      <Pressable
        style={[styles.rtkToggleOption, !isNtrip && styles.rtkToggleOptionActive]}
        onPress={() => onChange("Lora")}
      >
        <Radio color={!isNtrip ? COLORS.accentText : COLORS.textMuted} size={13} strokeWidth={2.2} />
        <Text style={[styles.rtkToggleText, !isNtrip && styles.rtkToggleTextActive]}>LoRa</Text>
      </Pressable>
    </View>
  );
};

const IconSegmentControl = ({
  options,
  value,
  onChange,
  compact = false,
}: {
  options: { id: string; label: string; icon: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }> }[];
  value: string;
  onChange: (id: string) => void;
  compact?: boolean;
}) => (
  <View style={[styles.segmented, compact && styles.segmentedCompact]}>
    {options.map((opt) => {
      const active = value === opt.id;
      const Icon = opt.icon;
      return (
        <Pressable
          key={opt.id}
          style={[
            styles.segmentBtn,
            styles.segmentBtnWithIcon,
            compact && styles.segmentBtnCompact,
            active && styles.segmentBtnActive,
          ]}
          onPress={() => onChange(opt.id)}
        >
          <Icon
            color={active ? COLORS.accentText : COLORS.textMuted}
            size={compact ? 13 : 15}
            strokeWidth={2.2}
          />
          <Text style={[styles.segmentText, compact && styles.segmentTextCompact, active && styles.segmentTextActive]}>
            {opt.label}
          </Text>
        </Pressable>
      );
    })}
  </View>
);

const SegmentControl = ({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) => (
  <View style={styles.segmented}>
    {options.map((opt) => {
      const active = value === opt.id;
      return (
        <Pressable
          key={opt.id}
          style={[styles.segmentBtn, active && styles.segmentBtnActive]}
          onPress={() => onChange(opt.id)}
        >
          <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

const ActionButton = ({
  label,
  onPress,
  disabled = false,
  loading = false,
  icon: Icon,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
  variant?: "primary" | "secondary" | "danger" | "success";
}) => {
  const variantStyle =
    variant === "danger"
      ? styles.dangerBtn
      : variant === "success"
        ? styles.successBtn
        : variant === "secondary"
          ? styles.secondaryBtn
          : styles.primaryBtn;

  const textStyle =
    variant === "primary"
      ? styles.primaryBtnText
      : variant === "secondary"
        ? styles.secondaryBtnText
        : styles.actionBtnText;

  const iconColor =
    variant === "primary" ? COLORS.accentText : COLORS.textMain;

  return (
    <Pressable
      style={[variantStyle, (disabled || loading) && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : Icon ? (
        <Icon color={iconColor} size={16} strokeWidth={2.2} />
      ) : null}
      <Text style={textStyle}>{loading ? "..." : label}</Text>
    </Pressable>
  );
};

export default function ModernSettingsPage(props: ModernSettingsPageProps) {
  const {
    rtkCaster = "",
    setRtkCaster,
    rtkPort = "2101",
    setRtkPort,
    rtkMountPoint = "",
    setRtkMountPoint,
    rtkUsername = "",
    setRtkUsername,
    rtkPassword = "",
    setRtkPassword,
    rtkRunning = false,
    rtkHealthy = false,
    rtkMode = "idle",
    setRtkDefaultMode,
    toggleA = false,
    toggleB = false,
    toggleC = true,
    setToggleA,
    setToggleB,
    setToggleC,
    apiBaseUrl,
    selectedPathName,
  } = props;

  const { width } = useWindowDimensions();
  const twoColumn = width >= 900;

  const [localRtkMode, setLocalRtkMode] = useState(
    rtkMode === "lora" ? "Lora" : "NTRIP"
  );
  const [importedFileName, setImportedFileName] = useState<string | null>(null);

  useEffect(() => {
    if (rtkMode === "lora") setLocalRtkMode("Lora");
    else if (rtkMode === "ntrip") setLocalRtkMode("NTRIP");
  }, [rtkMode]);

  const [isSprayMasterEnabled, setIsSprayMasterEnabled] = useState(false);
  const [isSprayMasterChanging, setIsSprayMasterChanging] = useState(false);
  const [isSprayOn, setIsSprayOn] = useState(false);
  const [isSprayOnChanging, setIsSprayOnChanging] = useState(false);
  const [sprayMode, setSprayMode] = useState<SprayMode>("continuous");
  const [dashDistanceOn, setDashDistanceOn] = useState("0.3");
  const [dashDistanceOff, setDashDistanceOff] = useState("0.3");
  const [pointExecutionMode, setPointExecutionMode] = useState<"auto" | "manual">("auto");
  const [isSettingSprayMode, setIsSettingSprayMode] = useState(false);
  const [sprayDuration, setSprayDuration] = useState("2");
  const [isSprayTestRunning, setIsSprayTestRunning] = useState(false);
  const [manualHoldActive, setManualHoldActive] = useState(false);
  const [sprayLive, setSprayLive] = useState(false);

  const manualHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sprayApiUrl = useCallback(
    (path: string) => {
      if (!apiBaseUrl) return "";
      return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
    },
    [apiBaseUrl]
  );

  const fieldsLocked = rtkRunning;

  useEffect(() => {
    if (!apiBaseUrl) return;

    const pollStatus = async () => {
      try {
        const res = await fetch(sprayApiUrl("/api/spray/status"));
        if (!res.ok) return;
        const data = await res.json();
        if (data.enabled !== undefined) setIsSprayMasterEnabled(!!data.enabled);
        const active = !!(data.spraying || data.manual_override || data.spray_active_desired);
        setSprayLive(active);
        setIsSprayOn(active);
        if (!manualHoldActive) setManualHoldActive(!!data.manual_override);
      } catch {
        // ignore polling errors
      }
    };

    pollStatus();
    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [apiBaseUrl, sprayApiUrl, manualHoldActive]);

  useEffect(() => {
    return () => {
      if (manualHeartbeatRef.current) clearInterval(manualHeartbeatRef.current);
    };
  }, []);

  const handleSprayMasterToggle = async (nextEnable: boolean) => {
    if (!apiBaseUrl || isSprayMasterChanging) return;
    setIsSprayMasterChanging(true);
    try {
      const res = await fetch(sprayApiUrl(nextEnable ? "/api/spray/enable" : "/api/spray/disable"), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to ${nextEnable ? "enable" : "disable"} spray hardware.`);
        return;
      }
      const data = await res.json().catch(() => ({}));
      setIsSprayMasterEnabled(data.enabled !== undefined ? !!data.enabled : nextEnable);
      if (!nextEnable) {
        setIsSprayOn(false);
        setSprayLive(false);
        setManualHoldActive(false);
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to connect to backend.");
    } finally {
      setIsSprayMasterChanging(false);
    }
  };

  const handleSprayPowerToggle = async (nextOn: boolean) => {
    if (!apiBaseUrl || isSprayOnChanging || !isSprayMasterEnabled) return;
    setIsSprayOnChanging(true);
    try {
      const res = await fetch(sprayApiUrl(nextOn ? "/api/spray/on" : "/api/spray/off"), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to turn spray ${nextOn ? "on" : "off"}.`);
        return;
      }
      setIsSprayOn(nextOn);
      setSprayLive(nextOn);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to connect to backend.");
    } finally {
      setIsSprayOnChanging(false);
    }
  };

  const handleSetSprayMode = async () => {
    if (!apiBaseUrl || !selectedPathName) {
      Alert.alert("No path", "Select a path on the Fields page before setting spray mode.");
      return;
    }
    setIsSettingSprayMode(true);
    try {
      let res: Response;
      const base = sprayApiUrl(`/api/path/${encodeURIComponent(selectedPathName)}/spray-mode`);

      if (sprayMode === "continuous") {
        res = await fetch(`${base}/continuous`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({}),
        });
      } else if (sprayMode === "dashed") {
        res = await fetch(`${base}/dash`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            dash_on_distance_m: parseFloat(dashDistanceOn) || 0.3,
            dash_off_distance_m: parseFloat(dashDistanceOff) || 0.3,
            dash_phase_reset: "per_mark_region",
          }),
        });
      } else {
        res = await fetch(`${base}/point`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ point_execution_mode: pointExecutionMode }),
        });
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Server error: ${res.status}`);
      }
      Alert.alert("Success", `Spray mode set to ${sprayMode}.`);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to set spray mode.");
    } finally {
      setIsSettingSprayMode(false);
    }
  };

  const handleSprayTest = async () => {
    if (!apiBaseUrl || isSprayTestRunning) return;
    setIsSprayTestRunning(true);
    try {
      const duration = Number(sprayDuration) || 2;
      const res = await fetch(sprayApiUrl("/api/spray/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ on: true, duration_s: duration }),
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to run spray test.");
        return;
      }
      setSprayLive(true);
      setTimeout(() => setSprayLive(false), duration * 1000);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to run spray test.");
    } finally {
      setIsSprayTestRunning(false);
    }
  };

  const startManualHold = async () => {
    if (!apiBaseUrl || manualHoldActive || manualHeartbeatRef.current || !isSprayMasterEnabled) return;
    try {
      await fetch(sprayApiUrl("/api/spray/on"), { method: "POST" });
      setManualHoldActive(true);
      setSprayLive(true);
      manualHeartbeatRef.current = setInterval(async () => {
        try {
          await fetch(sprayApiUrl("/api/spray/on"), { method: "POST" });
        } catch {
          // keep heartbeat best-effort
        }
      }, 7000);
    } catch (err: any) {
      Alert.alert("Error", err?.message || "Failed to start manual spray.");
    }
  };

  const stopManualHold = async () => {
    if (!apiBaseUrl) return;
    if (manualHeartbeatRef.current) {
      clearInterval(manualHeartbeatRef.current);
      manualHeartbeatRef.current = null;
    }
    try {
      await fetch(sprayApiUrl("/api/spray/off"), { method: "POST" });
    } catch {
      // best-effort off
    }
    setManualHoldActive(false);
    setSprayLive(false);
    setIsSprayOn(false);
  };

  const handleSetDefaultRtk = () => {
    if (setRtkDefaultMode) setRtkDefaultMode(localRtkMode);
    else Alert.alert("Saved", `${localRtkMode} set as default RTK mode.`);
  };

  const handleImportRtkTxt = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["text/plain", "text/*", "application/octet-stream", "*/*"],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      let content = "";

      if (Platform.OS === "web" && (asset as { file?: File }).file) {
        content = await (asset as { file: File }).file.text();
      } else {
        content = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
      }

      const parsed = parseRtkTxt(content);
      let applied = 0;

      if (parsed.caster && setRtkCaster) { setRtkCaster(parsed.caster); applied++; }
      if (parsed.port && setRtkPort) { setRtkPort(parsed.port); applied++; }
      if (parsed.mountPoint && setRtkMountPoint) { setRtkMountPoint(parsed.mountPoint); applied++; }
      if (parsed.username && setRtkUsername) { setRtkUsername(parsed.username); applied++; }
      if (parsed.password && setRtkPassword) { setRtkPassword(parsed.password); applied++; }

      if (applied === 0) {
        Alert.alert("Invalid File", "No matching RTK keys found. Use host, port, mountpoint, username, password.");
        return;
      }

      setImportedFileName(asset.name || "credentials.txt");
      Alert.alert("Imported", `Loaded ${applied} field${applied === 1 ? "" : "s"} from file.`);
    } catch {
      Alert.alert("Import Failed", "Could not read the RTK text file.");
    }
  };

  const isNtripMode = localRtkMode === "NTRIP";
  const credentialsComplete = !!(rtkCaster && rtkPort && rtkMountPoint && rtkUsername && rtkPassword);

  const rtkImportAction = (
    <Pressable
      style={[styles.uploadBtn, fieldsLocked && styles.btnDisabled]}
      onPress={handleImportRtkTxt}
      disabled={fieldsLocked}
    >
      <Upload color={COLORS.accentText} size={15} strokeWidth={2.2} />
      <Text style={styles.uploadBtnText}>Import .txt</Text>
    </Pressable>
  );

  const rtkSection = (
    <SettingsPanel
      icon={Satellite}
      title="RTK / LoRa"
      subtitle="Set your correction source and credentials"
      headerAction={isNtripMode ? rtkImportAction : undefined}
    >
      <RtkStatusStrip
        running={rtkRunning}
        healthy={rtkHealthy}
        mode={rtkMode}
        fieldsLocked={fieldsLocked}
      />

      <View style={styles.compactBlock}>
        <Text style={styles.blockLabel}>Connection</Text>
        <View style={styles.rtkActionRow}>
          <View style={styles.rtkToggleWrap}>
            <RtkModeToggle
              value={localRtkMode === "Lora" ? "Lora" : "NTRIP"}
              onChange={setLocalRtkMode}
            />
          </View>
          <Pressable style={[styles.rtkActionBtn, styles.rtkActionBtnSave]} onPress={handleSetDefaultRtk}>
            <Check color={COLORS.accentText} size={13} strokeWidth={2.4} />
            <Text style={styles.rtkActionBtnTextSave}>Save</Text>
          </Pressable>
        </View>
      </View>

      {isNtripMode ? (
        <View style={styles.block}>
          <View style={styles.rtkCredHeader}>
            <Text style={styles.rtkCredTitle}>Caster login</Text>
            <View style={[styles.rtkCredPill, credentialsComplete ? styles.rtkCredPillOk : styles.rtkCredPillWarn]}>
              <Text style={[styles.rtkCredPillText, credentialsComplete ? styles.rtkCredPillTextOk : styles.rtkCredPillTextWarn]}>
                {credentialsComplete ? "Ready" : "Fill all fields"}
              </Text>
            </View>
          </View>

          <SettingsField
            label="Host"
            value={rtkCaster}
            onChangeText={setRtkCaster || (() => {})}
            placeholder="caster.example.com"
            editable={!fieldsLocked && !!setRtkCaster}
          />
          <View style={styles.fieldRow}>
            <View style={{ flex: 0.75 }}>
              <SettingsField
                label="Port"
                value={rtkPort}
                onChangeText={setRtkPort || (() => {})}
                placeholder="2101"
                keyboardType="numeric"
                editable={!fieldsLocked && !!setRtkPort}
              />
            </View>
            <View style={{ flex: 1.25 }}>
              <SettingsField
                label="Mount point"
                value={rtkMountPoint}
                onChangeText={setRtkMountPoint || (() => {})}
                placeholder="MP23960a"
                editable={!fieldsLocked && !!setRtkMountPoint}
              />
            </View>
          </View>
          <SettingsField
            label="Username"
            value={rtkUsername}
            onChangeText={setRtkUsername || (() => {})}
            placeholder="Your NTRIP username"
            editable={!fieldsLocked && !!setRtkUsername}
          />
          <SettingsField
            label="Password"
            value={rtkPassword}
            onChangeText={setRtkPassword || (() => {})}
            placeholder="Your NTRIP password"
            secureTextEntry
            editable={!fieldsLocked && !!setRtkPassword}
          />

          {importedFileName ? (
            <View style={styles.importBadge}>
              <FileText color={COLORS.accentBrand} size={14} strokeWidth={2} />
              <Text style={styles.importBadgeText} numberOfLines={1}>Imported: {importedFileName}</Text>
            </View>
          ) : null}

          <Text style={styles.helpText}>
            Tip: import a .txt file with host, port, mountpoint, username, and password — or type them in above.
          </Text>
        </View>
      ) : (
        <View style={styles.noteBanner}>
          <Radio color={COLORS.accentBrand} size={14} strokeWidth={2.2} />
          <Text style={styles.noteBannerText}>
            Start LoRa RTK from the RTK button on the main screen.
          </Text>
        </View>
      )}
    </SettingsPanel>
  );

  const spraySection = (
    <SettingsPanel
      icon={Droplets}
      title="Spray"
      subtitle="Hardware, patterns, and testing"
    >
      {!apiBaseUrl ? (
        <View style={styles.noteBanner}>
          <Text style={styles.noteBannerText}>Connect to the rover to use spray controls.</Text>
        </View>
      ) : null}

      <View style={styles.block}>
        <SettingsToggle
          label="Enable spray"
          hint="Turns spray hardware on or off"
          value={isSprayMasterEnabled}
          onValueChange={handleSprayMasterToggle}
          disabled={!apiBaseUrl || isSprayMasterChanging}
        />
        {sprayLive ? (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>Spraying now</Text>
          </View>
        ) : null}
      </View>

      {isSprayMasterEnabled ? (
        <>
          <View style={styles.block}>
            <SettingsToggle
              label="Spray on"
              hint="Manual spray output"
              value={isSprayOn}
              onValueChange={handleSprayPowerToggle}
              disabled={!apiBaseUrl || isSprayOnChanging || manualHoldActive}
            />
          </View>

          <View style={styles.block}>
            <Text style={styles.blockLabel}>Pattern mode</Text>
            {selectedPathName ? (
              <Text style={styles.pathHint} numberOfLines={1}>Current path: {selectedPathName}</Text>
            ) : (
              <Text style={styles.pathHintWarn}>Select a path on Fields first</Text>
            )}
            <SegmentControl
              options={[
                { id: "continuous", label: "Continuous" },
                { id: "dashed", label: "Dashed" },
                { id: "point", label: "Point" },
              ]}
              value={sprayMode}
              onChange={(id) => setSprayMode(id as SprayMode)}
            />

            {sprayMode === "dashed" ? (
              <View style={styles.fieldRow}>
                <View style={{ flex: 1 }}>
                  <SettingsField
                    label="Dash ON (m)"
                    value={dashDistanceOn}
                    onChangeText={setDashDistanceOn}
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <SettingsField
                    label="Dash OFF (m)"
                    value={dashDistanceOff}
                    onChangeText={setDashDistanceOff}
                    keyboardType="numeric"
                  />
                </View>
              </View>
            ) : null}

            {sprayMode === "point" ? (
              <>
                <Text style={styles.blockLabel}>Point execution</Text>
                <SegmentControl
                  options={[
                    { id: "auto", label: "Auto" },
                    { id: "manual", label: "Manual" },
                  ]}
                  value={pointExecutionMode}
                  onChange={(id) => setPointExecutionMode(id as "auto" | "manual")}
                />
              </>
            ) : null}

            <ActionButton
              label="Apply pattern"
              icon={Check}
              onPress={handleSetSprayMode}
              loading={isSettingSprayMode}
              disabled={!apiBaseUrl || !selectedPathName}
            />
          </View>

          <View style={styles.block}>
            <Text style={styles.blockLabel}>Test spray</Text>
            <View style={styles.testRow}>
              <View style={{ flex: 1 }}>
                <SettingsField
                  label="Seconds"
                  value={sprayDuration}
                  onChangeText={setSprayDuration}
                  keyboardType="numeric"
                  placeholder="2"
                />
              </View>
              <ActionButton
                label="Run test"
                icon={Play}
                onPress={handleSprayTest}
                loading={isSprayTestRunning}
                disabled={!apiBaseUrl}
                variant="secondary"
              />
            </View>
          </View>

          <View style={styles.block}>
            <Text style={styles.blockLabel}>Hold to spray</Text>
            <Text style={styles.blockHint}>Press and hold the button below while spraying manually.</Text>
            <Pressable
              onPressIn={startManualHold}
              onPressOut={stopManualHold}
              disabled={!apiBaseUrl}
              style={({ pressed }) => [
                styles.holdBtn,
                manualHoldActive && styles.holdBtnActive,
                pressed && styles.holdBtnPressed,
                !apiBaseUrl && styles.btnDisabled,
              ]}
            >
              <Power
                color={manualHoldActive ? COLORS.accentText : COLORS.textMain}
                size={18}
                strokeWidth={2.2}
              />
              <Text style={[styles.holdBtnText, manualHoldActive && styles.holdBtnTextActive]}>
                {manualHoldActive ? "Spraying…" : "Hold to spray"}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </SettingsPanel>
  );

  const generalSection = (
    <SettingsPanel icon={Settings} title="General" subtitle="Field operation preferences">
      <View style={styles.block}>
        <SettingsToggle
          label="Auto line select"
          value={toggleA}
          onValueChange={setToggleA || (() => {})}
        />
        <SettingsToggle
          label="Hard surface / asphalt"
          value={toggleB}
          onValueChange={setToggleB || (() => {})}
        />
        <SettingsToggle
          label="Metric units"
          value={toggleC}
          onValueChange={setToggleC || (() => {})}
        />
      </View>
    </SettingsPanel>
  );

  return (
    <View style={styles.page}>
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>Settings</Text>
        <Text style={styles.pageSubtitle}>RTK, spray, and field preferences</Text>
      </View>

      <View style={[styles.columns, twoColumn ? styles.columnsRow : styles.columnsStack]}>
        <ScrollView
          style={styles.column}
          contentContainerStyle={styles.columnContent}
          showsVerticalScrollIndicator={false}
        >
          {rtkSection}
        </ScrollView>

        <ScrollView
          style={styles.column}
          contentContainerStyle={styles.columnContent}
          showsVerticalScrollIndicator={false}
        >
          {spraySection}
          {generalSection}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minHeight: 0,
    backgroundColor: COLORS.bgBase,
    padding: 14,
    gap: 12,
  },
  pageHeader: {
    gap: 2,
    paddingBottom: 2,
  },
  pageTitle: {
    color: COLORS.textMain,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  pageSubtitle: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "500",
  },
  columns: {
    flex: 1,
    gap: 12,
    minHeight: 0,
  },
  columnsRow: {
    flexDirection: "row",
  },
  columnsStack: {
    flexDirection: "column",
  },
  column: {
    flex: 1,
    minWidth: 0,
  },
  columnContent: {
    gap: 16,
    paddingBottom: 24,
  },
  panel: {
    backgroundColor: COLORS.panelSolid,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    overflow: "hidden",
    ...SHADOWS.panel,
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.panelBorder,
  },
  panelHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  panelIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: COLORS.accentMuted,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTitle: {
    color: COLORS.textMain,
    fontSize: 15,
    fontWeight: "700",
  },
  panelSubtitle: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
  },
  panelBody: {
    padding: 18,
    gap: 14,
  },
  block: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 14,
    gap: 12,
  },
  compactBlock: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
  },
  rtkActionRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 6,
    height: 38,
  },
  rtkToggleWrap: {
    flex: 2,
    minWidth: 0,
  },
  rtkToggleTrack: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 8,
    padding: 3,
    gap: 3,
    height: 38,
  },
  rtkToggleOption: {
    flex: 1,
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: 6,
  },
  rtkToggleOptionActive: {
    backgroundColor: COLORS.accentBrand,
  },
  rtkToggleText: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  rtkToggleTextActive: {
    color: COLORS.accentText,
  },
  rtkActionBtn: {
    flex: 1,
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 8,
  },
  rtkActionBtnSave: {
    backgroundColor: COLORS.accentBrand,
    borderColor: COLORS.accentBorder,
  },
  rtkActionBtnTextSave: {
    color: COLORS.accentText,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  blockLabel: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  blockHint: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 16,
  },
  pathHint: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  pathHintWarn: {
    color: COLORS.danger,
    fontSize: 11,
    fontWeight: "600",
  },
  field: {
    gap: 6,
  },
  fieldRow: {
    flexDirection: "row",
    gap: 10,
  },
  fieldLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
  },
  input: {
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
    color: COLORS.textMain,
    fontSize: 14,
  },
  inputDisabled: {
    opacity: 0.65,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 4,
  },
  toggleRowDisabled: {
    opacity: 0.55,
  },
  toggleLabel: {
    color: COLORS.textMain,
    fontSize: 13,
    fontWeight: "600",
  },
  toggleHint: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
    lineHeight: 15,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: COLORS.surfaceSolid,
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    gap: 4,
  },
  segmentedCompact: {
    borderRadius: 8,
    padding: 3,
    gap: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentBtnCompact: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: 6,
    gap: 4,
  },
  segmentBtnWithIcon: {
    flexDirection: "row",
    gap: 6,
  },
  segmentBtnActive: {
    backgroundColor: COLORS.accentBrand,
  },
  segmentText: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },
  segmentTextCompact: {
    fontSize: 10,
  },
  segmentTextActive: {
    color: COLORS.accentText,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    alignSelf: "stretch",
    backgroundColor: COLORS.accentBrand,
    borderRadius: 10,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
  },
  primaryBtnText: {
    color: COLORS.accentText,
    fontSize: 13,
    fontWeight: "800",
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: COLORS.surfaceSolid,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    alignSelf: "flex-end",
    marginTop: 18,
  },
  secondaryBtnText: {
    color: COLORS.textMain,
    fontSize: 13,
    fontWeight: "700",
  },
  successBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: COLORS.successMuted,
    borderRadius: 10,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: COLORS.successBorder,
  },
  dangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: COLORS.dangerMuted,
    borderRadius: 10,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: COLORS.dangerBorder,
  },
  actionBtnText: {
    color: COLORS.textMain,
    fontSize: 13,
    fontWeight: "800",
  },
  btnDisabled: {
    opacity: 0.5,
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: COLORS.accentBrand,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
  },
  uploadBtnText: {
    color: COLORS.accentText,
    fontSize: 11,
    fontWeight: "800",
  },
  importBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.accentMuted,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  importBadgeText: {
    flex: 1,
    color: COLORS.textMain,
    fontSize: 12,
    fontWeight: "600",
  },
  helpText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 16,
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    backgroundColor: COLORS.successMuted,
    borderWidth: 1,
    borderColor: COLORS.successBorder,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.success,
  },
  liveBadgeText: {
    color: COLORS.success,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  testRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
  },
  holdBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    alignSelf: "stretch",
    minHeight: 48,
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 12,
    paddingVertical: 14,
  },
  holdBtnActive: {
    backgroundColor: COLORS.accentBrand,
    borderColor: COLORS.accentBorder,
  },
  holdBtnPressed: {
    opacity: 0.85,
  },
  holdBtnText: {
    color: COLORS.textMain,
    fontSize: 14,
    fontWeight: "800",
  },
  holdBtnTextActive: {
    color: COLORS.accentText,
  },
  holdHeartbeat: {
    color: COLORS.success,
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
  },
  noteBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noteBannerText: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "500",
    lineHeight: 16,
  },
  rtkStatusStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: COLORS.cardSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  rtkStatusLive: {
    backgroundColor: COLORS.successMuted,
    borderColor: COLORS.successBorder,
  },
  rtkStatusWarn: {
    backgroundColor: COLORS.warningMuted,
    borderColor: COLORS.warningBorder,
  },
  rtkBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    height: 14,
  },
  rtkBar: {
    width: 3,
    borderRadius: 2,
  },
  rtkStatusLine: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
  },
  rtkCredHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  rtkCredTitle: {
    color: COLORS.textMain,
    fontSize: 14,
    fontWeight: "700",
  },
  rtkCredPill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
  },
  rtkCredPillOk: {
    backgroundColor: COLORS.successMuted,
    borderColor: COLORS.successBorder,
  },
  rtkCredPillWarn: {
    backgroundColor: COLORS.warningMuted,
    borderColor: COLORS.warningBorder,
  },
  rtkCredPillText: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  rtkCredPillTextOk: {
    color: COLORS.success,
  },
  rtkCredPillTextWarn: {
    color: COLORS.warning,
  },
});