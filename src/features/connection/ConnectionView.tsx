import React from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Waves } from "lucide-react-native";
import type { DiscoveredRover } from "../../types/appRuntime";

export function ConnectionView({
  selectedWs,
  manualHost,
  wsError,
  wsStatus,
  password,
  onPasswordChange,
  hasStoredSession,
  isOffline,
  discoveredRovers,
  onRefresh,
  onSelect,
  onManualHostChange,
  onConnect,
  onOfflinePreview,
}: {
  selectedWs: string;
  manualHost: string;
  wsError: string;
  wsStatus: string;
  password: string;
  onPasswordChange: (value: string) => void;
  hasStoredSession: boolean;
  isOffline: boolean;
  discoveredRovers: Array<{ id: string; name: string; host: string; port: number; version?: string; responseTime?: number }>;
  onRefresh: () => void;
  onSelect: (value: string) => void;
  onManualHostChange: (value: string) => void;
  onConnect: () => void;
  onOfflinePreview: () => void;
}) {
  const selectedTarget = selectedWs || manualHost;
  const pingState =
    wsStatus === "scanning" ? "Checking" : wsStatus === "connecting" ? "Connecting" : isOffline ? "No reply" : "Ready";
  const healthState = selectedWs
    ? wsStatus === "connected"
      ? "Connected"
      : wsStatus === "connecting"
        ? "Connecting"
        : "Selected"
    : "No target";
  const discoverState = discoveredRovers.length > 0 ? `${discoveredRovers.length} found` : "None yet";

  return (
    <View style={{ flex: 1, backgroundColor: "#eef2f7", padding: 16 }}>
      <View
        style={{
          flex: 1,
          maxWidth: 1280,
          width: "100%",
          alignSelf: "center",
          flexDirection: "row",
          gap: 14,
        }}
      >
        <View
          style={{
            flex: 0.95,
            borderRadius: 26,
            backgroundColor: "#0f172a",
            padding: 20,
            justifyContent: "space-between",
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 22,
            shadowOffset: { width: 0, height: 12 },
            elevation: 5,
          }}
        >
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <View
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 999,
                  backgroundColor: isOffline ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)",
                  borderWidth: 1,
                  borderColor: isOffline ? "rgba(239,68,68,0.28)" : "rgba(34,197,94,0.22)",
                }}
              >
                <Text style={{ color: isOffline ? "#fecaca" : "#bbf7d0", fontSize: 12, fontWeight: "800" }}>
                  {isOffline ? "Offline" : "Backend reachable"}
                </Text>
              </View>
              {wsStatus === "scanning" || wsStatus === "connecting" ? (
                <View
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: "rgba(96,165,250,0.12)",
                    borderWidth: 1,
                    borderColor: "rgba(96,165,250,0.22)",
                  }}
                >
                  <Text style={{ color: "#bfdbfe", fontSize: 12, fontWeight: "800" }}>
                    {wsStatus === "connecting" ? "Connecting" : "Scanning network"}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={{ gap: 8 }}>
              <Text style={{ color: "#f8fafc", fontSize: 36, fontWeight: "900", lineHeight: 40 }}>
                Connect to Rover Backend
              </Text>
              <Text style={{ color: "#cbd5e1", fontSize: 15, lineHeight: 22, maxWidth: 440 }}>
                The tablet scans the current Wi-Fi subnet for a reachable backend, then lets you connect to continue into the main app.
              </Text>
            </View>
          </View>

          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              <View style={connectionStyles.infoCard}>
                <Text style={connectionStyles.infoValue}>1</Text>
                <Text style={connectionStyles.infoLabel}>Ping</Text>
                <Text style={connectionStyles.infoText}>{pingState}</Text>
                <Text style={connectionStyles.infoDetail}>{selectedTarget}</Text>
              </View>
              <View style={connectionStyles.infoCard}>
                <Text style={connectionStyles.infoValue}>2</Text>
                <Text style={connectionStyles.infoLabel}>Health</Text>
                <Text style={connectionStyles.infoText}>{healthState}</Text>
                <Text style={connectionStyles.infoDetail}>Socket.IO on port 5001</Text>
              </View>
              <View style={connectionStyles.infoCard}>
                <Text style={connectionStyles.infoValue}>3</Text>
                <Text style={connectionStyles.infoLabel}>Discover</Text>
                <Text style={connectionStyles.infoText}>{discoverState}</Text>
                <Text style={connectionStyles.infoDetail}>Auto-scanned on current Wi-Fi</Text>
              </View>
            </View>

            <View style={{ paddingTop: 8, borderTopWidth: 1, borderTopColor: "rgba(148,163,184,0.18)" }}>
              <Text style={{ color: "#cbd5e1", fontSize: 12, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" }}>
                How it works
              </Text>
              <Text style={{ color: "#94a3b8", fontSize: 13, lineHeight: 20, marginTop: 6 }}>
                The connection screen auto-scans the network, shows any discovered rover targets, and lets you connect dynamically.
              </Text>
            </View>
          </View>
        </View>

        <View
          style={{
            flex: 1.05,
            borderRadius: 26,
            backgroundColor: "#ffffff",
            padding: 16,
            shadowColor: "#000",
            shadowOpacity: 0.06,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 10 },
            elevation: 3,
            borderWidth: 1,
            borderColor: "#d7dee8",
          }}
        >
          <View style={{ flex: 1, justifyContent: "space-between", gap: 14 }}>
            <View style={{ gap: 12 }}>
              <View>
                <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "800" }}>Manual backend address</Text>
                <Text style={{ color: "#64748b", marginTop: 4, fontSize: 13, lineHeight: 18 }}>
                  Type the rover IP if discovery does not show it.
                </Text>
              </View>

              <TextInput
                value={manualHost}
                onChangeText={onManualHostChange}
                placeholder="http://192.168.1.102:5001"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  borderRadius: 16,
                  paddingHorizontal: 14,
                  paddingVertical: 14,
                  color: "#0f172a",
                  backgroundColor: "#f8fafc",
                }}
              />

              <TextInput
                value={password}
                onChangeText={onPasswordChange}
                placeholder={
                  hasStoredSession
                    ? "Password optional for this backend; required after rover restart"
                    : "Rover password"
                }
                placeholderTextColor="#94a3b8"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  borderRadius: 16,
                  paddingHorizontal: 14,
                  paddingVertical: 14,
                  color: "#0f172a",
                  backgroundColor: "#f8fafc",
                }}
              />

              {wsError ? (
                <View style={{ padding: 12, borderRadius: 14, backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca", marginTop: 4 }}>
                  <Text style={{ color: "#b91c1c", fontWeight: "700" }}>{wsError}</Text>
                </View>
              ) : null}

              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => onSelect(manualHost)}
                  style={{
                    backgroundColor: "#0f172a",
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderRadius: 16,
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "800" }}>Use manual address</Text>
                </Pressable>
                <Pressable
                  onPress={onConnect}
                  disabled={!manualHost || wsStatus === "connecting"}
                  style={{
                    backgroundColor: !manualHost ? "#94a3b8" : "#2563eb",
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderRadius: 16,
                    opacity: wsStatus === "connecting" ? 0.85 : 1,
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "800" }}>
                    {wsStatus === "connecting" ? "Connecting..." : "Connect"}
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={{ flex: 1, minHeight: 0 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                <View style={{ flex: 1, minWidth: 150 }}>
                  <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "800" }}>Available Connections</Text>
                  <Text style={{ color: "#64748b", marginTop: 4, fontSize: 13, lineHeight: 18 }}>
                    Select an active rover backend discovered on your network.
                  </Text>
                </View>
                <Pressable
                  onPress={onRefresh}
                  disabled={wsStatus === "scanning"}
                  style={{
                    backgroundColor: "#e2e8f0",
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 12,
                    alignSelf: "flex-start",
                  }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800" }}>
                    {wsStatus === "scanning" ? "Scanning..." : "Refresh scan"}
                  </Text>
                </Pressable>
              </View>

              <View style={{ flex: 1, gap: 10, marginTop: 8 }}>
                {discoveredRovers.length > 0 ? (
                  <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                    {discoveredRovers.map((rover) => {
                      const url = `http://${rover.host}:${rover.port}`;
                      const isSelected = selectedWs === url;
                      return (
                        <Pressable
                          key={`${rover.id}-${url}`}
                          onPress={() => onSelect(url)}
                          style={{
                            padding: 12,
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: isSelected ? "#0f172a" : "#d7dee8",
                            backgroundColor: isSelected ? "#eef2ff" : "#ffffff",
                          }}
                        >
                          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: "#0f172a", fontWeight: "800", fontSize: 15 }}>{rover.name}</Text>
                              <Text style={{ color: "#64748b", marginTop: 4 }}>{url}</Text>
                            </View>
                            <View
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 999,
                                backgroundColor: isSelected ? "#0f172a" : "#f1f5f9",
                              }}
                            >
                              <Text style={{ color: isSelected ? "#fff" : "#334155", fontSize: 11, fontWeight: "800" }}>
                                {isSelected ? "Selected" : "Tap to select"}
                              </Text>
                            </View>
                          </View>
                          <Text style={{ color: "#64748b", marginTop: 6, fontSize: 12 }}>
                            {rover.version ? `v${rover.version}` : "Socket.IO backend"}
                            {typeof rover.responseTime === "number" ? ` • ${rover.responseTime} ms` : ""}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <View
                    style={{
                      flex: 1,
                      borderRadius: 18,
                      borderWidth: 1,
                      borderColor: "#d7dee8",
                      backgroundColor: "#f8fafc",
                      padding: 16,
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#334155", fontSize: 15, lineHeight: 22, textAlign: "center" }}>
                      No active backend found. Ensure the server is running on the laptop and tap "Refresh scan" above.
                    </Text>
                  </View>
                )}
              </View>
            </View>

            <View style={{ gap: 10 }}>
              {wsError ? (
                <View style={{ padding: 12, borderRadius: 14, backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca" }}>
                  <Text style={{ color: "#b91c1c", fontWeight: "700" }}>{wsError}</Text>
                </View>
              ) : null}

              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable
                  onPress={onConnect}
                  disabled={!selectedTarget || wsStatus === "connecting"}
                  style={{
                    flex: 1,
                    backgroundColor: !selectedTarget ? "#94a3b8" : "#2563eb",
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderRadius: 16,
                    opacity: wsStatus === "connecting" ? 0.85 : 1,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "800" }}>
                    {wsStatus === "connecting" ? "Connecting..." : "Connect"}
                  </Text>
                </Pressable>
              </View>

              <Pressable
                onPress={onOfflinePreview}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 14,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  backgroundColor: "#f8fafc",
                  alignItems: "center",
                  flexDirection: "row",
                  justifyContent: "center",
                  gap: 12,
                  minHeight: 72,
                  shadowColor: "#0f172a",
                  shadowOpacity: 0.05,
                  shadowRadius: 10,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 1,
                }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    backgroundColor: "#e2e8f0",
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                  }}
                >
                  <Waves size={19} color="#0f172a" />
                </View>
                <View style={{ flex: 1, paddingRight: 4 }}>
                  <Text style={{ color: "#0f172a", fontWeight: "900", fontSize: 15.5 }}>Offline Preview</Text>
                  <Text style={{ color: "#64748b", fontSize: 12, marginTop: 2, lineHeight: 16 }}>
                    Open the app without connecting to the backend
                  </Text>
                </View>
                <View
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: "#e2e8f0",
                  }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 11, fontWeight: "800" }}>Local</Text>
                </View>
              </Pressable>

              <Text style={{ color: "#64748b", fontSize: 12, lineHeight: 18 }}>
                Backend runs on <Text style={{ color: "#334155", fontWeight: "700" }}>server/main.py</Text> via Socket.IO on port <Text style={{ color: "#334155", fontWeight: "700" }}>5001</Text>.
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const connectionStyles = {
  infoCard: {
    flexGrow: 1,
    minWidth: 120,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.16)",
  },
  infoValue: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "900" as const,
  },
  infoLabel: {
    color: "#e2e8f0",
    fontSize: 13,
    fontWeight: "800" as const,
    marginTop: 4,
  },
  infoText: {
    color: "#94a3b8",
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
  },
  infoDetail: {
    color: "#cbd5e1",
    fontSize: 11,
    marginTop: 8,
    lineHeight: 16,
    opacity: 0.9,
  },
};

export default ConnectionView;
