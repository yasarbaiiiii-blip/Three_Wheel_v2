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
  ActivityIndicator,
} from "react-native";
import {
  Settings,
  Droplets,
  Check,
  Power,
  Satellite,
  Square,
  Gauge,
  SlidersHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react-native";
import SchemaParamEditor from "./settings/SchemaParamEditor";
import { NtripProfileConflictError } from "../api/rtkProfiles";
import { useNtripProfiles } from "../hooks/useNtripProfiles";
import type { NtripProfile } from "../types/appRuntime";

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

type SprayMode = "continuous" | "dashed" | "point";
type SettingsSection = "connection" | "drive" | "spray" | "general";

type ModernSettingsPageProps = {
  rtkRunning?: boolean;
  rtkHealthy?: boolean;
  rtkMode?: string;
  stopRtk?: () => Promise<void>;
  toggleA?: boolean;
  toggleB?: boolean;
  toggleC?: boolean;
  setToggleA?: (v: boolean) => void;
  setToggleB?: (v: boolean) => void;
  setToggleC?: (v: boolean) => void;
  apiBaseUrl?: string;
  selectedPathName?: string | null;
};

type ProfileEditorMode = { kind: "create" } | { kind: "edit"; profile: NtripProfile };

type ProfileForm = {
  name: string;
  host: string;
  port: string;
  mountpoint: string;
  username: string;
  password: string;
};

const EMPTY_PROFILE_FORM: ProfileForm = {
  name: "",
  host: "",
  port: "2101",
  mountpoint: "",
  username: "",
  password: "",
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
          <Icon color={COLORS.accentBrand} size={14} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.panelTitle} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.panelSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
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
}: {
  running: boolean;
  healthy: boolean;
  mode: string;
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
  <View style={[styles.tabBar, compact && styles.tabBarCompact]}>
    {options.map((opt) => {
      const active = value === opt.id;
      const Icon = opt.icon;
      return (
        <Pressable
          key={opt.id}
          style={[
            styles.tabPill,
            compact && styles.tabPillCompact,
            active && styles.tabPillActive,
          ]}
          onPress={() => onChange(opt.id)}
        >
          <Icon
            color={active ? COLORS.accentText : COLORS.textMuted}
            size={13}
            strokeWidth={2.2}
          />
          <Text
            numberOfLines={1}
            style={[styles.tabPillText, compact && styles.tabPillTextCompact, active && styles.tabPillTextActive]}
          >
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
    rtkRunning = false,
    rtkHealthy = false,
    rtkMode = "idle",
    stopRtk,
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
  const compactTabs = width < 720;
  const wide = width >= 720;
  const [section, setSection] = useState<SettingsSection>("connection");
  const profiles = useNtripProfiles(apiBaseUrl);
  const [profileEditor, setProfileEditor] = useState<ProfileEditorMode | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE_FORM);

  const [isSprayMasterEnabled, setIsSprayMasterEnabled] = useState(false);
  const [isSprayMasterChanging, setIsSprayMasterChanging] = useState(false);
  const [isSprayOn, setIsSprayOn] = useState(false);
  const [isSprayOnChanging, setIsSprayOnChanging] = useState(false);
  const [sprayMode, setSprayMode] = useState<SprayMode>("continuous");
  const [dashDistanceOn, setDashDistanceOn] = useState("0.3");
  const [dashDistanceOff, setDashDistanceOff] = useState("0.3");
  const [pointExecutionMode, setPointExecutionMode] = useState<"auto" | "manual">("auto");
  const [isSettingSprayMode, setIsSettingSprayMode] = useState(false);
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

  const [isStoppingRtk, setIsStoppingRtk] = useState(false);
  const handleStopRtk = async () => {
    if (!stopRtk || isStoppingRtk) return;
    setIsStoppingRtk(true);
    try {
      await stopRtk();
    } finally {
      setIsStoppingRtk(false);
    }
  };

  const closeProfileEditor = useCallback(() => {
    setProfileEditor(null);
    // Passwords are intentionally held only in this transient form state.
    setProfileForm(EMPTY_PROFILE_FORM);
  }, []);

  useEffect(() => {
    closeProfileEditor();
  }, [apiBaseUrl, closeProfileEditor]);

  const openCreateProfile = useCallback(() => {
    setProfileForm(EMPTY_PROFILE_FORM);
    setProfileEditor({ kind: "create" });
  }, []);

  const openEditProfile = useCallback((profile: NtripProfile) => {
    setProfileForm({
      name: profile.name,
      host: profile.host,
      port: String(profile.port),
      mountpoint: profile.mountpoint,
      username: profile.username,
      password: "",
    });
    setProfileEditor({ kind: "edit", profile });
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (!profileEditor) return;
    const name = profileForm.name.trim();
    const host = profileForm.host.trim();
    const mountpoint = profileForm.mountpoint.trim().replace(/^\/+/, "");
    const username = profileForm.username.trim();
    const password = profileForm.password;
    const port = Number(profileForm.port);

    if (!name || !host || !mountpoint || !username) {
      Alert.alert("Missing details", "Enter a profile name, host, mountpoint, and username.");
      return;
    }
    if (/^https?:\/\//i.test(host)) {
      Alert.alert("Invalid host", "Enter the caster hostname or IP without http:// or https://.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      Alert.alert("Invalid port", "Port must be a whole number from 1 to 65535.");
      return;
    }
    if (profileEditor.kind === "create" && password.length === 0) {
      Alert.alert("Password required", "Enter the caster password for the new profile.");
      return;
    }

    try {
      if (profileEditor.kind === "create") {
        await profiles.createProfile({ name, host, port, mountpoint, username, password });
        Alert.alert("Profile saved", `${name} is stored on the rover. Set it as default when ready.`);
      } else {
        await profiles.updateProfile(profileEditor.profile.id, {
          name,
          host,
          port,
          mountpoint,
          username,
          ...(password.length > 0 ? { password } : {}),
        });
        const runtimeNote = profileEditor.profile.is_active
          ? " The current correction stream is unchanged."
          : "";
        Alert.alert("Profile updated", `${name} was saved.${runtimeNote}`);
      }
      closeProfileEditor();
    } catch (error) {
      Alert.alert(
        error instanceof NtripProfileConflictError ? "Profiles changed" : "Save failed",
        error instanceof Error ? error.message : "Could not save the NTRIP profile."
      );
    } finally {
      // Clear the write-only secret after every submit attempt.
      setProfileForm((current) => ({ ...current, password: "" }));
    }
  }, [closeProfileEditor, profileEditor, profileForm, profiles]);

  const handleSetDefaultProfile = useCallback(async (profile: NtripProfile) => {
    try {
      await profiles.setDefaultProfile(profile.id);
      Alert.alert(
        "Default profile saved",
        `${profile.name} will be used on the next rover-server start. The current correction stream is unchanged.`
      );
    } catch (error) {
      Alert.alert(
        error instanceof NtripProfileConflictError ? "Profiles changed" : "Default failed",
        error instanceof Error ? error.message : "Could not set the default profile."
      );
    }
  }, [profiles]);

  const handleDeleteProfile = useCallback((profile: NtripProfile) => {
    if (profile.is_default || profile.is_active) return;
    Alert.alert(
      "Delete NTRIP profile?",
      `Delete ${profile.name} from the rover? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void profiles.removeProfile(profile.id).catch((error) => {
              Alert.alert(
                error instanceof NtripProfileConflictError ? "Profiles changed" : "Delete failed",
                error instanceof Error ? error.message : "Could not delete the NTRIP profile."
              );
            });
          },
        },
      ]
    );
  }, [profiles]);

  const sectionCopy: Record<SettingsSection, { title: string; subtitle: string }> = {
    connection: { title: "RTK", subtitle: "Backend-managed NTRIP profiles" },
    drive: { title: "Drive", subtitle: "RPP speed, profile, and tracking knobs" },
    spray: { title: "Spray", subtitle: "Hardware, pattern, and spray variables" },
    general: { title: "General", subtitle: "Field operation preferences" },
  };

  const addProfileAction = (
    <Pressable
      style={[styles.uploadBtn, (!apiBaseUrl || profiles.mutationKey !== null) && styles.btnDisabled]}
      onPress={openCreateProfile}
      disabled={!apiBaseUrl || profiles.mutationKey !== null}
    >
      <Plus color={COLORS.accentText} size={15} strokeWidth={2.2} />
      <Text style={styles.uploadBtnText}>Add profile</Text>
    </Pressable>
  );

  const rtkSection = (
    <SettingsPanel
      icon={Satellite}
      title="RTK / NTRIP"
      subtitle="Authenticated backend profiles; caster secrets are never stored on this tablet"
      headerAction={addProfileAction}
    >
      <RtkStatusStrip
        running={rtkRunning}
        healthy={rtkHealthy}
        mode={rtkMode}
      />

      {rtkRunning ? (
        <View style={styles.compactBlock}>
          <ActionButton
            label={isStoppingRtk ? "Stopping…" : "Stop RTK"}
            icon={Square}
            variant="danger"
            onPress={handleStopRtk}
            loading={isStoppingRtk}
            disabled={!stopRtk}
          />
        </View>
      ) : null}

      {!apiBaseUrl ? (
        <View style={styles.noteBanner}>
          <Text style={styles.noteBannerText}>Connect and authenticate to the rover to manage NTRIP profiles.</Text>
        </View>
      ) : null}

      {profiles.error ? (
        <View style={[styles.noteBanner, styles.profileErrorBanner]}>
          <Text style={styles.profileErrorText}>{profiles.error}</Text>
          <Pressable
            style={styles.profileIconButton}
            onPress={() => void profiles.reload()}
            disabled={profiles.loading}
            accessibilityLabel="Retry loading NTRIP profiles"
          >
            <RefreshCw color={COLORS.textMain} size={15} strokeWidth={2.2} />
          </Pressable>
        </View>
      ) : null}

      {profileEditor ? (
        <View style={styles.block}>
          <View style={styles.rtkCredHeader}>
            <Text style={styles.rtkCredTitle}>
              {profileEditor.kind === "create" ? "New NTRIP profile" : `Edit ${profileEditor.profile.name}`}
            </Text>
            <Text style={styles.profilePasswordHint}>
              {profileEditor.kind === "edit" && profileEditor.profile.password_configured
                ? "Password saved"
                : "Password required"}
            </Text>
          </View>

          <SettingsField
            label="Profile name"
            value={profileForm.name}
            onChangeText={(name) => setProfileForm((current) => ({ ...current, name }))}
            placeholder="Chennai site"
            editable={profiles.mutationKey === null}
          />
          <View style={styles.fieldRow}>
            <View style={{ flex: 1.4 }}>
              <SettingsField
                label="Host"
                value={profileForm.host}
                onChangeText={(host) => setProfileForm((current) => ({ ...current, host }))}
                placeholder="caster.example.com"
                editable={profiles.mutationKey === null}
              />
            </View>
            <View style={{ flex: 0.6 }}>
              <SettingsField
                label="Port"
                value={profileForm.port}
                onChangeText={(port) => setProfileForm((current) => ({ ...current, port }))}
                placeholder="2101"
                keyboardType="numeric"
                editable={profiles.mutationKey === null}
              />
            </View>
          </View>
          <View style={styles.fieldRow}>
            <View style={{ flex: 1 }}>
              <SettingsField
                label="Mount"
                value={profileForm.mountpoint}
                onChangeText={(mountpoint) => setProfileForm((current) => ({ ...current, mountpoint }))}
                placeholder="MP23960a"
                editable={profiles.mutationKey === null}
              />
            </View>
            <View style={{ flex: 1 }}>
              <SettingsField
                label="User"
                value={profileForm.username}
                onChangeText={(username) => setProfileForm((current) => ({ ...current, username }))}
                placeholder="Username"
                editable={profiles.mutationKey === null}
              />
            </View>
          </View>
          <SettingsField
            label="Password"
            value={profileForm.password}
            onChangeText={(password) => setProfileForm((current) => ({ ...current, password }))}
            placeholder={profileEditor.kind === "edit" ? "Leave blank to keep saved password" : "Password"}
            secureTextEntry
            editable={profiles.mutationKey === null}
          />
          <Text style={styles.helpText}>
            {profileEditor.kind === "edit"
              ? "Leave password blank to retain the backend's saved password. Enter a new value to replace it."
              : "The password is sent with your authenticated X-Rover-Token request and is never saved on this tablet."}
          </Text>
          <View style={styles.profileEditorActions}>
            <ActionButton
              label="Cancel"
              variant="secondary"
              onPress={closeProfileEditor}
              disabled={profiles.mutationKey !== null}
            />
            <ActionButton
              label="Save profile"
              icon={Check}
              onPress={() => void handleSaveProfile()}
              loading={profiles.mutationKey === "create" || profiles.mutationKey?.startsWith("edit:") === true}
            />
          </View>
        </View>
      ) : null}

      {apiBaseUrl && profiles.loading && profiles.profiles.length === 0 ? (
        <View style={styles.profileLoading}>
          <ActivityIndicator color={COLORS.accentBrand} size="small" />
          <Text style={styles.noteBannerText}>Loading profiles from rover…</Text>
        </View>
      ) : null}

      {apiBaseUrl && !profiles.loading && profiles.profiles.length === 0 && !profiles.error ? (
        <View style={styles.profileEmpty}>
          <Text style={styles.rtkCredTitle}>No NTRIP profiles configured</Text>
          <Text style={styles.helpText}>Add the first caster profile, then set it as the rover default.</Text>
          <ActionButton label="Add profile" icon={Plus} onPress={openCreateProfile} />
        </View>
      ) : null}

      {profiles.profiles.map((profile) => {
        const busy = profiles.mutationKey?.endsWith(`:${profile.id}`) === true;
        const deleteLocked = profile.is_default || profile.is_active;
        return (
          <View key={profile.id} style={styles.profileCard}>
            <View style={styles.profileCardHeader}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.profileName} numberOfLines={1}>{profile.name}</Text>
                <Text style={styles.profileEndpoint} numberOfLines={1}>
                  {profile.host}:{profile.port}/{profile.mountpoint}
                </Text>
              </View>
              <View style={styles.profileBadges}>
                {profile.is_default ? <Text style={styles.profileBadgeDefault}>DEFAULT</Text> : null}
                {profile.is_active ? <Text style={styles.profileBadgeActive}>ACTIVE</Text> : null}
                {profile.pending_apply ? <Text style={styles.profileBadgePending}>PENDING APPLY</Text> : null}
              </View>
            </View>
            <Text style={styles.profileMeta} numberOfLines={1}>
              User: {profile.username} · {profile.password_configured ? "Password saved" : "Password missing"}
            </Text>
            {profile.pending_apply ? (
              <Text style={styles.profilePendingNote}>
                {profile.is_default && !profile.is_active
                  ? "Default saved. Current correction stream is unchanged."
                  : "Saved edits will apply when this profile starts again. Current stream is unchanged."}
              </Text>
            ) : null}
            <View style={styles.profileActions}>
              {!profile.is_default ? (
                <ActionButton
                  label="Set default"
                  variant="success"
                  onPress={() => void handleSetDefaultProfile(profile)}
                  loading={profiles.mutationKey === `default:${profile.id}`}
                  disabled={profiles.mutationKey !== null && !busy}
                />
              ) : null}
              <ActionButton
                label="Edit"
                icon={Pencil}
                variant="secondary"
                onPress={() => openEditProfile(profile)}
                disabled={profiles.mutationKey !== null}
              />
              <ActionButton
                label="Delete"
                icon={Trash2}
                variant="danger"
                onPress={() => handleDeleteProfile(profile)}
                loading={profiles.mutationKey === `delete:${profile.id}`}
                disabled={deleteLocked || (profiles.mutationKey !== null && !busy)}
              />
            </View>
            {deleteLocked ? (
              <Text style={styles.profileDeleteHint}>
                {profile.is_default ? "Choose another default before deleting." : "An active profile cannot be deleted."}
              </Text>
            ) : null}
          </View>
        );
      })}
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
      <View style={[styles.topBar, compactTabs && styles.topBarStack]}>
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle}>Settings</Text>
          <Text style={styles.pageSubtitle} numberOfLines={1}>{sectionCopy[section].subtitle}</Text>
        </View>
        <IconSegmentControl
          compact={compactTabs}
          value={section}
          onChange={(id) => setSection(id as SettingsSection)}
          options={[
            { id: "connection", label: "RTK", icon: Satellite },
            { id: "drive", label: "Drive", icon: Gauge },
            { id: "spray", label: "Spray", icon: Droplets },
            { id: "general", label: "General", icon: Settings },
          ]}
        />
      </View>

      <ScrollView
        style={styles.column}
        contentContainerStyle={styles.columnContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {section === "connection" ? rtkSection : null}
        {section === "drive" ? (
          <SchemaParamEditor
            apiBaseUrl={apiBaseUrl}
            family="rpp"
            title="Drive / RPP"
            subtitle="Apply writes only the values you change"
            icon={Gauge}
          />
        ) : null}
        {section === "spray" ? (
          <View style={wide ? styles.split : styles.stack}>
            <View style={wide ? styles.splitCol : undefined}>{spraySection}</View>
            <View style={wide ? styles.splitCol : undefined}>
              <SchemaParamEditor
                apiBaseUrl={apiBaseUrl}
                family="spray"
                title="Spray variables"
                subtitle="Timing, nozzle, actuator"
                icon={SlidersHorizontal}
              />
            </View>
          </View>
        ) : null}
        {section === "general" ? generalSection : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    minHeight: 0,
    backgroundColor: COLORS.bgBase,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 6,
    gap: 6,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  topBarStack: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 6,
  },
  pageHeader: {
    gap: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  pageTitle: {
    color: COLORS.textMain,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  pageSubtitle: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: "500",
  },
  tabBar: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: COLORS.surfaceSolid,
    borderRadius: 8,
    padding: 3,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    gap: 3,
  },
  tabBarCompact: {
    alignSelf: "stretch",
  },
  tabPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  tabPillCompact: {
    flex: 1,
    paddingHorizontal: 4,
    paddingVertical: 5,
  },
  tabPillActive: {
    backgroundColor: COLORS.accentBrand,
  },
  tabPillText: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "700",
  },
  tabPillTextCompact: {
    fontSize: 10,
  },
  tabPillTextActive: {
    color: COLORS.accentText,
  },
  split: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  splitCol: {
    flex: 1,
    minWidth: 0,
  },
  stack: {
    gap: 8,
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
    gap: 8,
    paddingBottom: 16,
  },
  panel: {
    backgroundColor: COLORS.panelSolid,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
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
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: COLORS.accentMuted,
    borderWidth: 1,
    borderColor: COLORS.accentBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTitle: {
    color: COLORS.textMain,
    fontSize: 13,
    fontWeight: "700",
  },
  panelSubtitle: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontWeight: "500",
    marginTop: 1,
  },
  panelBody: {
    padding: 8,
    gap: 6,
  },
  block: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 8,
    gap: 6,
  },
  compactBlock: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    paddingHorizontal: 8,
    paddingVertical: 7,
    gap: 6,
  },
  rtkActionRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 6,
    height: 34,
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
    height: 34,
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
    height: 34,
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
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    minHeight: 32,
    color: COLORS.textMain,
    fontSize: 13,
  },
  inputDisabled: {
    opacity: 0.65,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 2,
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
    borderRadius: 8,
    padding: 3,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    gap: 3,
  },
  segmentedCompact: {
    borderRadius: 8,
    padding: 3,
    gap: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
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
    borderRadius: 8,
    paddingVertical: 8,
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
    marginTop: 6,
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
  holdBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    alignSelf: "stretch",
    minHeight: 40,
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    borderRadius: 8,
    paddingVertical: 8,
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
    paddingHorizontal: 8,
    paddingVertical: 6,
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
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
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
  profileErrorBanner: {
    borderColor: COLORS.dangerBorder,
    backgroundColor: COLORS.dangerMuted,
  },
  profileErrorText: {
    flex: 1,
    color: COLORS.danger,
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 16,
  },
  profileIconButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  profilePasswordHint: {
    color: COLORS.success,
    fontSize: 10,
    fontWeight: "700",
  },
  profileEditorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 2,
  },
  profileLoading: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: COLORS.cardSolid,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  profileEmpty: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 14,
    backgroundColor: COLORS.cardSolid,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
  },
  profileCard: {
    backgroundColor: COLORS.cardSolid,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.panelBorder,
    padding: 10,
    gap: 7,
  },
  profileCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  profileName: {
    color: COLORS.textMain,
    fontSize: 14,
    fontWeight: "800",
  },
  profileEndpoint: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
  },
  profileMeta: {
    color: COLORS.textDim,
    fontSize: 10,
    fontWeight: "600",
  },
  profileBadges: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 4,
    maxWidth: "48%",
  },
  profileBadgeDefault: {
    color: COLORS.accentBrand,
    backgroundColor: COLORS.accentMuted,
    borderColor: COLORS.accentBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 8,
    fontWeight: "900",
  },
  profileBadgeActive: {
    color: COLORS.success,
    backgroundColor: COLORS.successMuted,
    borderColor: COLORS.successBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 8,
    fontWeight: "900",
  },
  profileBadgePending: {
    color: COLORS.warning,
    backgroundColor: COLORS.warningMuted,
    borderColor: COLORS.warningBorder,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 8,
    fontWeight: "900",
  },
  profilePendingNote: {
    color: COLORS.warning,
    fontSize: 10,
    fontWeight: "600",
  },
  profileActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 7,
  },
  profileDeleteHint: {
    color: COLORS.textDim,
    fontSize: 9,
    textAlign: "right",
  },
});
