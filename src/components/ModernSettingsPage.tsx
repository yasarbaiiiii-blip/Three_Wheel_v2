import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TextInput, Pressable, Switch } from "react-native";
import { Save, Check } from "lucide-react-native";

const COLORS = {
  bg: "#1c1c1c",
  surface: "#2b2b2b",
  primary: "#f4c10c", // Safety Yellow
  textMain: "#f5f5f0",
  textMuted: "#7a7a72",
  border: "rgba(255,255,255,0.1)",
  danger: "#cc1f1f",
  success: "#3aa15a",
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
    setRtkDefaultMode
  } = props;

  // Local spray settings
  const [sprayMaster, setSprayMaster] = useState(false);
  const [sprayState, setSprayState] = useState(false); // On / Off
  const [sprayMode, setSprayMode] = useState("DASHED"); // SOLID / DASHED
  const [dashDistanceOn, setDashDistanceOn] = useState("0.3");
  const [dashDistanceOff, setDashDistanceOff] = useState("0.3");

  // Local RTK selection
  const [localRtkMode, setLocalRtkMode] = useState("NTRIP");

  const handleSetDefaultRtk = () => {
    if (setRtkDefaultMode) setRtkDefaultMode(localRtkMode);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 24, gap: 32 }}>
      <Text style={styles.pageTitle}>System Settings</Text>

      {/* RTK Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RTK / LoRa Credentials</Text>
        <View style={styles.card}>
          <View style={styles.row}>
             <Text style={styles.label}>Connection Mode</Text>
             <View style={styles.segmentedControl}>
                <Pressable 
                   style={[styles.segmentBtn, localRtkMode === "NTRIP" && styles.segmentActive]}
                   onPress={() => setLocalRtkMode("NTRIP")}
                >
                   <Text style={[styles.segmentText, localRtkMode === "NTRIP" && styles.segmentTextActive]}>NTRIP</Text>
                </Pressable>
                <Pressable 
                   style={[styles.segmentBtn, localRtkMode === "Lora" && styles.segmentActive]}
                   onPress={() => setLocalRtkMode("Lora")}
                >
                   <Text style={[styles.segmentText, localRtkMode === "Lora" && styles.segmentTextActive]}>LoRa</Text>
                </Pressable>
             </View>
          </View>
          
          <Pressable style={styles.actionBtn} onPress={handleSetDefaultRtk}>
             <Check size={16} color={COLORS.bg} />
             <Text style={styles.actionBtnText}>Set Default</Text>
          </Pressable>

          <View style={{ height: 1, backgroundColor: COLORS.border, marginVertical: 8 }} />

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

      {/* Spray Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Spray Hardware Control</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Enable Spray Hardware</Text>
            <Switch value={sprayMaster} onValueChange={setSprayMaster} trackColor={{ false: COLORS.border, true: COLORS.primary }} />
          </View>
          
          {sprayMaster && (
            <>
               <View style={{ height: 1, backgroundColor: COLORS.border, marginVertical: 8 }} />
               <View style={styles.row}>
                 <Text style={styles.label}>Spray Power (On/Off)</Text>
                 <Switch value={sprayState} onValueChange={setSprayState} trackColor={{ false: COLORS.border, true: COLORS.primary }} />
               </View>
               <View style={styles.row}>
                  <Text style={styles.label}>Spray Mode</Text>
                  <View style={styles.segmentedControl}>
                     <Pressable 
                        style={[styles.segmentBtn, sprayMode === "SOLID" && styles.segmentActive]}
                        onPress={() => setSprayMode("SOLID")}
                     >
                        <Text style={[styles.segmentText, sprayMode === "SOLID" && styles.segmentTextActive]}>SOLID</Text>
                     </Pressable>
                     <Pressable 
                        style={[styles.segmentBtn, sprayMode === "DASHED" && styles.segmentActive]}
                        onPress={() => setSprayMode("DASHED")}
                     >
                        <Text style={[styles.segmentText, sprayMode === "DASHED" && styles.segmentTextActive]}>DASHED</Text>
                     </Pressable>
                  </View>
               </View>

               {sprayMode === "DASHED" && (
                 <>
                   <Text style={[styles.label, { marginTop: 12, marginBottom: 8, color: COLORS.primary }]}>Dashed Line Pattern</Text>
                   <View style={styles.inputGroup}>
                     <Text style={styles.label}>Dash Distance ON (m)</Text>
                     <TextInput style={styles.input} value={dashDistanceOn} onChangeText={setDashDistanceOn} keyboardType="numeric" placeholderTextColor={COLORS.textMuted} />
                   </View>
                   <View style={styles.inputGroup}>
                     <Text style={styles.label}>Dash Distance OFF (m)</Text>
                     <TextInput style={styles.input} value={dashDistanceOff} onChangeText={setDashDistanceOff} keyboardType="numeric" placeholderTextColor={COLORS.textMuted} />
                   </View>
                 </>
               )}
            </>
          )}
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
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  segmentBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 6,
  },
  segmentActive: {
    backgroundColor: COLORS.surface,
  },
  segmentText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  segmentTextActive: {
    color: COLORS.primary,
  },
  actionBtn: {
    flexDirection: "row",
    backgroundColor: COLORS.primary,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  actionBtnText: {
    color: COLORS.bg,
    fontSize: 14,
    fontWeight: "800",
  }
});
