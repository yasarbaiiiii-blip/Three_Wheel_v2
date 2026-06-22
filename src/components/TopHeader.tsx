import React from "react";
import { Pressable, Text, View } from "react-native";
import { Menu } from "lucide-react-native";

import type { Palette } from "../theme/colors";

type MachineStatus = "connected" | "degraded" | "disconnected";

interface TopHeaderProps {
  title: string;
  fileName?: string;
  status: MachineStatus;
  palette: Palette;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

const statusMap: Record<MachineStatus, { label: string; color: string }> = {
  connected: { label: "RTK Fixed", color: "#059669" },
  degraded: { label: "Float", color: "#D97706" },
  disconnected: { label: "Alert", color: "#DC2626" },
};

export function TopHeader({
  title,
  fileName,
  status,
  palette,
  sidebarVisible,
  onToggleSidebar,
}: TopHeaderProps) {
  return (
    <View
      className="h-[112px] flex-row items-stretch px-5 py-3"
      style={{
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
        backgroundColor: palette.panel,
        gap: 14,
      }}
    >
      <View
        className="flex-row items-center rounded-2xl border px-4"
        style={{
          gap: 12,
          flex: 1.2,
          minWidth: 0,
          borderColor: palette.border,
          backgroundColor: palette.background,
        }}
      >
        <Pressable
          onPress={onToggleSidebar}
          className="h-14 w-14 items-center justify-center rounded-2xl"
          style={{
            borderWidth: 1,
            borderColor: palette.border,
            backgroundColor: sidebarVisible ? palette.muted : "transparent",
          }}
        >
          <Menu color={palette.foreground} size={28} />
        </Pressable>

        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text className="text-xl font-semibold" style={{ color: palette.foreground }}>
            {title}
          </Text>
          {fileName ? (
            <Text
              numberOfLines={1}
              className="mt-0.5 text-base"
              style={{ color: palette.mutedForeground }}
            >
              File:{" "}
              <Text className="font-semibold" style={{ color: palette.foreground }}>
                {fileName}
              </Text>
            </Text>
          ) : null}
        </View>
      </View>

      <View
        className="flex-row items-stretch justify-center rounded-2xl border px-4 py-3"
        style={{
          flex: 1.05,
          minWidth: 0,
          borderColor: palette.border,
          backgroundColor: palette.background,
        }}
      >
        <View style={{ flex: 1, justifyContent: "space-between", gap: 8 }}>
          <View
            style={{
              flex: 1,
              borderRadius: 16,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: palette.panel,
              borderWidth: 1,
              borderColor: palette.border,
              justifyContent: "center",
            }}
          >
            <Text className="text-xs font-semibold uppercase" style={{ color: palette.mutedForeground, letterSpacing: 1 }}>
              Current Status
            </Text>
            <Text className="mt-1 text-lg font-semibold" style={{ color: palette.foreground }} numberOfLines={1}>
              {statusMap[status].label}
            </Text>
            <Text className="mt-1 text-sm" style={{ color: palette.mutedForeground }} numberOfLines={2}>
              {fileName ? `Working on ${fileName}` : "No plan loaded yet"}
            </Text>
          </View>

          <View
            style={{
              flex: 1,
              borderRadius: 16,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: "#f8fafc",
              borderWidth: 1,
              borderColor: "#d8e1eb",
              justifyContent: "center",
            }}
          >
            <Text className="text-xs font-semibold uppercase" style={{ color: palette.mutedForeground, letterSpacing: 1 }}>
              Focus
            </Text>
            <Text className="mt-1 text-base font-semibold" style={{ color: palette.foreground }} numberOfLines={1}>
              {fileName ? "Plan loaded and ready" : "Ready to import a field"}
            </Text>
            <Text className="mt-1 text-sm" style={{ color: palette.mutedForeground }} numberOfLines={2}>
              {status === "connected"
                ? "Machine is connected and data is updating."
                : "Connection status will appear here once available."}
            </Text>
          </View>
        </View>
      </View>

      <View
        className="flex-row items-stretch justify-end rounded-2xl border px-4 py-3"
        style={{
          gap: 12,
          flex: 1.1,
          minWidth: 0,
          borderColor: palette.border,
          backgroundColor: palette.background,
        }}
      >
        <View
          className="flex-1 rounded-xl p-1"
          style={{
            backgroundColor: palette.muted,
            gap: 6,
          }}
        >
          <Text className="text-xs font-semibold uppercase" style={{ color: palette.mutedForeground, letterSpacing: 1 }}>
            Quick Note
          </Text>
          <Text className="mt-1 text-base font-semibold" style={{ color: palette.foreground }}>
            {status === "connected" ? "System healthy" : "Awaiting machine connection"}
          </Text>
          <Text className="mt-1 text-sm" style={{ color: palette.mutedForeground }} numberOfLines={2}>
            This section can hold one short operational message without wasting height.
          </Text>
        </View>
      </View>
    </View>
  );
}
