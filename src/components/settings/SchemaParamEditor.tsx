import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Gauge, RefreshCw } from "lucide-react-native";
import {
  advancedParams,
  baselineValue,
  buildDirtyPayload,
  coerceParamValue,
  coerceTypedValue,
  ENUM_OPTIONS,
  fetchControllerParams,
  fieldParams,
  formatParamValue,
  groupParams,
  INERT_PARAM_NAMES,
  isBoolParam,
  isNumericParam,
  liveValueCount,
  paramLabel,
  paramUnit,
  setControllerParams,
  valuesEqual,
  type ControllerParam,
  type ParamFamily,
  type ParamValue,
} from "../../api/controllerParams";
import { SETTINGS_COLORS } from "./settingsTheme";
import { VerticalValueDial } from "./VerticalValueDial";

type SchemaParamEditorProps = {
  apiBaseUrl?: string;
  family: ParamFamily;
  title: string;
  subtitle: string;
  icon?: React.ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;
};

type ParamRowProps = {
  param: ControllerParam;
  value: ParamValue | null;
  draft: string;
  error: string | null;
  dirty: boolean;
  onDraftChange: (name: string, draft: string) => void;
  onCommitDraft: (name: string) => void;
  onTypedChange: (name: string, value: ParamValue) => void;
};

const EnumChips = memo(function EnumChips({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
});

const ParamRow = memo(function ParamRow({
  param,
  value,
  draft,
  error,
  dirty,
  onDraftChange,
  onCommitDraft,
  onTypedChange,
}: ParamRowProps) {
  const unit = paramUnit(param.name);
  const inert = INERT_PARAM_NAMES.has(param.name);
  const enumOptions = ENUM_OPTIONS[param.name];
  const numeric = isNumericParam(param) && !enumOptions;
  const numericValue = typeof value === "number" && Number.isFinite(value) ? value : Number(param.default);
  const boolValue = Boolean(value);

  return (
    <View style={[styles.row, dirty && styles.rowDirty, inert && styles.rowInert]}>
      <View style={styles.rowCopy}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{paramLabel(param.name)}</Text>
          {unit ? <Text style={styles.unit}>{unit}</Text> : null}
          {dirty ? <View style={styles.dirtyDot} /> : null}
        </View>
        {param.description ? (
          <Text style={styles.rowHint} numberOfLines={3}>
            {param.description}
          </Text>
        ) : null}
        {inert ? (
          <View style={styles.inertBadge}>
            <AlertTriangle color={SETTINGS_COLORS.warning} size={11} strokeWidth={2.4} />
            <Text style={styles.inertText}>Inert — kept for contract only</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.rowError}>{error}</Text> : null}
      </View>

      {isBoolParam(param) ? (
        <Switch
          value={boolValue}
          onValueChange={(next) => onTypedChange(param.name, next)}
          trackColor={{ false: SETTINGS_COLORS.surfaceSolid, true: SETTINGS_COLORS.accentBrand }}
          thumbColor={boolValue ? SETTINGS_COLORS.accentText : SETTINGS_COLORS.textMuted}
        />
      ) : enumOptions ? (
        <View style={{ flex: 1 }}>
          <EnumChips
            options={enumOptions}
            value={String(value ?? param.default ?? "") === "sharp" ? "segment" : String(value ?? param.default ?? "")}
            onChange={(next) => onTypedChange(param.name, next)}
          />
        </View>
      ) : (
        <View style={styles.controls}>
          {numeric && Number.isFinite(numericValue) ? (
            <VerticalValueDial
              param={param}
              value={numericValue}
              onChange={(next) => onTypedChange(param.name, next)}
            />
          ) : null}
          <View style={styles.manual}>
            <Text style={styles.manualLabel}>Manual</Text>
            <TextInput
              value={draft}
              onChangeText={(text) => onDraftChange(param.name, text)}
              onBlur={() => onCommitDraft(param.name)}
              onSubmitEditing={() => onCommitDraft(param.name)}
              keyboardType={numeric ? "decimal-pad" : "default"}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, error ? styles.inputError : null]}
              placeholder={formatParamValue(param.default)}
              placeholderTextColor={SETTINGS_COLORS.textDim}
            />
            {typeof param.min === "number" || typeof param.max === "number" ? (
              <Text style={styles.range}>
                {typeof param.min === "number" ? param.min : "—"} to {typeof param.max === "number" ? param.max : "—"}
              </Text>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
});

export default function SchemaParamEditor({
  apiBaseUrl,
  family,
  title,
  subtitle,
  icon: Icon = Gauge,
}: SchemaParamEditorProps) {
  const [params, setParams] = useState<ControllerParam[]>([]);
  const [edits, setEdits] = useState<Record<string, ParamValue>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!apiBaseUrl) {
      setParams([]);
      setEdits({});
      setDrafts({});
      setErrors({});
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchControllerParams(apiBaseUrl, family);
      setParams(next);
      setEdits({});
      setDrafts({});
      setErrors({});
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "Failed to load parameters.");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, family]);

  useEffect(() => {
    load();
  }, [load]);

  const valueOf = useCallback(
    (param: ControllerParam): ParamValue | null => {
      if (param.name in edits) return edits[param.name];
      return baselineValue(param);
    },
    [edits]
  );

  const draftOf = useCallback(
    (param: ControllerParam): string => {
      if (param.name in drafts) return drafts[param.name];
      return formatParamValue(valueOf(param));
    },
    [drafts, valueOf]
  );

  const applyEdit = useCallback((param: ControllerParam, next: ParamValue) => {
    setErrors((prev) => {
      if (!(param.name in prev)) return prev;
      const copy = { ...prev };
      delete copy[param.name];
      return copy;
    });
    setDrafts((prev) => {
      const formatted = formatParamValue(next);
      if (prev[param.name] === formatted) return prev;
      const copy = { ...prev };
      delete copy[param.name];
      return copy;
    });
    setEdits((prev) => {
      const baseline = baselineValue(param);
      if (valuesEqual(next, baseline, param.type)) {
        if (!(param.name in prev)) return prev;
        const copy = { ...prev };
        delete copy[param.name];
        return copy;
      }
      return { ...prev, [param.name]: next };
    });
  }, []);

  const paramsByName = useMemo(() => new Map(params.map((item) => [item.name, item])), [params]);

  const handleTypedChange = useCallback(
    (name: string, value: ParamValue) => {
      const param = paramsByName.get(name);
      if (!param) return;
      try {
        applyEdit(param, coerceTypedValue(value, param));
      } catch (err: unknown) {
        setErrors((prev) => ({ ...prev, [name]: err instanceof Error ? err.message : "Invalid value" }));
      }
    },
    [applyEdit, paramsByName]
  );

  const handleDraftChange = useCallback((name: string, draft: string) => {
    setDrafts((prev) => ({ ...prev, [name]: draft }));
  }, []);

  const handleCommitDraft = useCallback(
    (name: string) => {
      const param = paramsByName.get(name);
      if (!param) return;
      const raw = drafts[name] ?? formatParamValue(valueOf(param));
      try {
        applyEdit(param, coerceParamValue(raw, param));
      } catch (err: unknown) {
        setErrors((prev) => ({ ...prev, [name]: err instanceof Error ? err.message : "Invalid value" }));
      }
    },
    [applyEdit, drafts, paramsByName, valueOf]
  );

  const field = useMemo(() => fieldParams(params, family), [family, params]);
  const advanced = useMemo(() => advancedParams(params, family), [family, params]);
  const advancedGroups = useMemo(() => groupParams(advanced), [advanced]);
  const dirtyCount = Object.keys(edits).length;
  const liveCount = liveValueCount(params);
  const offline = params.length > 0 && liveCount === 0;

  const handleSave = useCallback(async () => {
    if (!apiBaseUrl || dirtyCount === 0) return;
    setSaving(true);
    try {
      const payload = buildDirtyPayload(params, edits);
      await setControllerParams(apiBaseUrl, family, payload);
      await load();
    } catch (err: unknown) {
      Alert.alert("Could not apply", err instanceof Error ? err.message : "Parameter update failed.");
    } finally {
      setSaving(false);
    }
  }, [apiBaseUrl, dirtyCount, edits, family, load, params]);

  const handleDiscard = useCallback(() => {
    setEdits({});
    setDrafts({});
    setErrors({});
  }, []);

  const toggleGroup = useCallback((group: string) => {
    setOpenGroups((prev) => ({ ...prev, [group]: !prev[group] }));
  }, []);

  const renderRows = (items: ControllerParam[]) =>
    items.map((param) => (
      <ParamRow
        key={param.name}
        param={param}
        value={valueOf(param)}
        draft={draftOf(param)}
        error={errors[param.name] ?? null}
        dirty={param.name in edits}
        onDraftChange={handleDraftChange}
        onCommitDraft={handleCommitDraft}
        onTypedChange={handleTypedChange}
      />
    ));

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.iconWrap}>
            <Icon color={SETTINGS_COLORS.accentBrand} size={18} strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>
        </View>
        <Pressable onPress={load} disabled={loading || !apiBaseUrl} style={styles.refreshBtn}>
          {loading ? (
            <ActivityIndicator color={SETTINGS_COLORS.accentText} size="small" />
          ) : (
            <RefreshCw color={SETTINGS_COLORS.accentText} size={14} strokeWidth={2.4} />
          )}
        </Pressable>
      </View>

      <View style={styles.body}>
        {!apiBaseUrl ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Connect to the rover to load live controller settings.</Text>
          </View>
        ) : null}

        {loadError ? (
          <View style={[styles.banner, styles.bannerWarn]}>
            <Text style={styles.bannerText}>{loadError}</Text>
          </View>
        ) : null}

        {offline ? (
          <View style={[styles.banner, styles.bannerWarn]}>
            <Text style={styles.bannerText}>
              Controller offline — showing schema defaults. Apply will fail until the node is up.
            </Text>
          </View>
        ) : null}

        {params.length > 0 ? (
          <View style={styles.metaRow}>
            <Text style={styles.meta}>
              {field.length} field · {advanced.length} advanced
            </Text>
            <Text style={styles.meta}>{liveCount}/{params.length} live</Text>
          </View>
        ) : null}

        {loading && params.length === 0 ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={SETTINGS_COLORS.accentBrand} />
            <Text style={styles.bannerText}>Loading parameters…</Text>
          </View>
        ) : null}

        {field.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Field</Text>
            {renderRows(field)}
          </View>
        ) : null}

        {advanced.length > 0 ? (
          <View style={styles.section}>
            <Pressable onPress={() => setAdvancedOpen((open) => !open)} style={styles.advancedToggle}>
              {advancedOpen ? (
                <ChevronDown color={SETTINGS_COLORS.accentBrand} size={16} strokeWidth={2.4} />
              ) : (
                <ChevronRight color={SETTINGS_COLORS.textMuted} size={16} strokeWidth={2.4} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.advancedTitle}>Advanced</Text>
                <Text style={styles.advancedHint}>{advanced.length} extra controller knobs</Text>
              </View>
            </Pressable>
            {advancedOpen
              ? advancedGroups.map(({ group, params: items }) => {
                  const open = openGroups[group] ?? false;
                  return (
                    <View key={group} style={styles.group}>
                      <Pressable onPress={() => toggleGroup(group)} style={styles.groupHeader}>
                        {open ? (
                          <ChevronDown color={SETTINGS_COLORS.textMuted} size={14} strokeWidth={2.4} />
                        ) : (
                          <ChevronRight color={SETTINGS_COLORS.textMuted} size={14} strokeWidth={2.4} />
                        )}
                        <Text style={styles.groupTitle}>{group}</Text>
                        <Text style={styles.groupCount}>{items.length}</Text>
                      </Pressable>
                      {open ? renderRows(items) : null}
                    </View>
                  );
                })
              : null}
          </View>
        ) : null}

        <View style={styles.footer}>
          <Pressable
            onPress={handleDiscard}
            disabled={dirtyCount === 0 || saving}
            style={[styles.footerBtn, styles.discardBtn, dirtyCount === 0 && styles.btnDisabled]}
          >
            <Text style={styles.discardText}>Discard</Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            disabled={dirtyCount === 0 || saving || !apiBaseUrl}
            style={[styles.footerBtn, styles.applyBtn, (dirtyCount === 0 || saving) && styles.btnDisabled]}
          >
            {saving ? (
              <ActivityIndicator color={SETTINGS_COLORS.accentText} size="small" />
            ) : (
              <Check color={SETTINGS_COLORS.accentText} size={16} strokeWidth={2.4} />
            )}
            <Text style={styles.applyText}>{saving ? "Applying…" : `Apply ${dirtyCount || ""}`.trim()}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: SETTINGS_COLORS.panelSolid,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: SETTINGS_COLORS.panelBorder,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: SETTINGS_COLORS.accentMuted,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.accentBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: SETTINGS_COLORS.textMain,
    fontSize: 15,
    fontWeight: "700",
  },
  subtitle: {
    color: SETTINGS_COLORS.textMuted,
    fontSize: 11,
    fontWeight: "500",
    marginTop: 2,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: SETTINGS_COLORS.accentBrand,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    padding: 18,
    gap: 14,
  },
  banner: {
    backgroundColor: SETTINGS_COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bannerWarn: {
    backgroundColor: SETTINGS_COLORS.warningMuted,
    borderColor: SETTINGS_COLORS.warningBorder,
  },
  bannerText: {
    color: SETTINGS_COLORS.textMuted,
    fontSize: 12,
    fontWeight: "500",
    lineHeight: 16,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  meta: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  loadingBox: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 18,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  row: {
    backgroundColor: SETTINGS_COLORS.cardSolid,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
    padding: 14,
    gap: 12,
  },
  rowDirty: {
    borderColor: SETTINGS_COLORS.accentBorder,
    backgroundColor: SETTINGS_COLORS.accentMuted,
  },
  rowInert: {
    opacity: 0.78,
  },
  rowCopy: {
    gap: 4,
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowTitle: {
    color: SETTINGS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "capitalize",
    flexShrink: 1,
  },
  unit: {
    color: SETTINGS_COLORS.accentBrand,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  dirtyDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: SETTINGS_COLORS.accentBrand,
  },
  rowHint: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 15,
  },
  rowError: {
    color: SETTINGS_COLORS.danger,
    fontSize: 11,
    fontWeight: "600",
  },
  inertBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  inertText: {
    color: SETTINGS_COLORS.warning,
    fontSize: 10,
    fontWeight: "700",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
  },
  manual: {
    flex: 1,
    gap: 6,
  },
  manualLabel: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: SETTINGS_COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 44,
    color: SETTINGS_COLORS.textMain,
    fontSize: 16,
    fontVariant: ["tabular-nums"],
  },
  inputError: {
    borderColor: SETTINGS_COLORS.danger,
  },
  range: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "600",
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: SETTINGS_COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
  },
  chipActive: {
    backgroundColor: SETTINGS_COLORS.accentBrand,
    borderColor: SETTINGS_COLORS.accentBorder,
  },
  chipText: {
    color: SETTINGS_COLORS.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  chipTextActive: {
    color: SETTINGS_COLORS.accentText,
  },
  advancedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: SETTINGS_COLORS.cardSolid,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  advancedTitle: {
    color: SETTINGS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "700",
  },
  advancedHint: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 11,
    marginTop: 1,
  },
  group: {
    gap: 8,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  groupTitle: {
    flex: 1,
    color: SETTINGS_COLORS.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  groupCount: {
    color: SETTINGS_COLORS.textDim,
    fontSize: 10,
    fontWeight: "700",
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingTop: 4,
  },
  footerBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  discardBtn: {
    backgroundColor: SETTINGS_COLORS.surfaceSolid,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.panelBorder,
  },
  discardText: {
    color: SETTINGS_COLORS.textMain,
    fontSize: 13,
    fontWeight: "700",
  },
  applyBtn: {
    backgroundColor: SETTINGS_COLORS.accentBrand,
    borderWidth: 1,
    borderColor: SETTINGS_COLORS.accentBorder,
  },
  applyText: {
    color: SETTINGS_COLORS.accentText,
    fontSize: 13,
    fontWeight: "800",
  },
  btnDisabled: {
    opacity: 0.45,
  },
});
