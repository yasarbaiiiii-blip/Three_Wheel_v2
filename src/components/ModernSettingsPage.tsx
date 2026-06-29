import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch } from "react-native";
import { Save } from "lucide-react-native";

const COLORS = {
  bg: "#1c1c1c",
  surface: "#2b2b2b",
  primary: "#f4c10c", // Safety Yellow
  textMain: "#f5f5f0",
  textMuted: "#7a7a72",
  border: "rgba(255,255,255,0.1)",
  danger: "#cc1f1f",
};

export default function ModernSettingsPage(props: any) {
  const {
    rtkCaster, setRtkCaster,
    rtkPort, setRtkPort,
    rtkMountPoint, setRtkMountPoint,
    rtkUsername, setRtkUsername,
    rtkPassword, setRtkPassword,
    delayA, setDelayA,
    toggleA, setToggleA,
    toggleB, setToggleB,
    toggleC, setToggleC,
  } = props;

  // Local spray settings to mimic the old modal
  const [dashDistanceOn, setDashDistanceOn] = useState("0.3");
  const [dashDistanceOff, setDashDistanceOff] = useState("0.3");
  const [sprayMaster, setSprayMaster] = useState(false);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 24, gap: 32 }}>
      <Text style={styles.pageTitle}>System Settings</Text>

      {/* RTK Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RTK / LoRa Credentials</Text>
        <View style={styles.card}>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>NTRIP Caster</Text>
            <TextInput style={styles.input} value={rtkCaster} onChangeText={setRtkCaster} placeholderTextColor={COLORS.textMuted} />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Port</Text>
            <TextInput style={styles.input} value={rtkPort} onChangeText={setRtkPort} keyboardType="numeric" placeholderTextColor={COLORS.textMuted} />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Mount Point</Text>
            <TextInput style={styles.input} value={rtkMountPoint} onChangeText={setRtkMountPoint} placeholderTextColor={COLORS.textMuted} />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Username</Text>
            <TextInput style={styles.input} value={rtkUsername} onChangeText={setRtkUsername} placeholderTextColor={COLORS.textMuted} />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput style={styles.input} value={rtkPassword} onChangeText={setRtkPassword} secureTextEntry placeholderTextColor={COLORS.textMuted} />
          </View>
        </View>
      </View>

      {/* Spray Logic Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Spray Logic & Hardware</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Enable Spray Hardware</Text>
            <Switch value={sprayMaster} onValueChange={setSprayMaster} trackColor={{ false: COLORS.border, true: COLORS.primary }} />
          </View>
          
          <View style={{ height: 1, backgroundColor: COLORS.border, marginVertical: 16 }} />

          <Text style={[styles.label, { marginBottom: 12 }]}>Dashed Line Pattern</Text>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Dash Distance ON (m)</Text>
            <TextInput style={styles.input} value={dashDistanceOn} onChangeText={setDashDistanceOn} keyboardType="numeric" placeholderTextColor={COLORS.textMuted} />
          </View>
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Dash Distance OFF (m)</Text>
            <TextInput style={styles.input} value={dashDistanceOff} onChangeText={setDashDistanceOff} keyboardType="numeric" placeholderTextColor={COLORS.textMuted} />
          </View>
        </View>
      </View>

      {/* General Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>General Preferences</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Auto Line Select</Text>
            <Switch value={toggleA} onValueChange={setToggleA} trackColor={{ false: COLORS.border, true: COLORS.primary }} />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Hard Surface / Asphalt</Text>
            <Switch value={toggleB} onValueChange={setToggleB} trackColor={{ false: COLORS.border, true: COLORS.primary }} />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Metric Units</Text>
            <Switch value={toggleC} onValueChange={setToggleC} trackColor={{ false: COLORS.border, true: COLORS.primary }} />
          </View>
        </View>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  pageTitle: {
    color: COLORS.textMain,
    fontSize: 24,
    fontWeight: "900",
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 16,
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    color: COLORS.textMain,
    fontSize: 13,
    fontWeight: "600",
  },
  input: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.textMain,
    fontSize: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
});
