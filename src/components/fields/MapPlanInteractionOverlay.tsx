import React, { useCallback, useRef, useState } from "react";
import { Animated, GestureResponderEvent, PanResponder, Pressable, Text, View } from "react-native";
import { Check, Maximize2, Move, RotateCw } from "lucide-react-native";

import { FIELDS_COLORS } from "./fieldsTheme";
import { TransformHUD } from "./TransformHUD";
import type { PlanManipulationMode, TransformHUDData } from "../../types/fieldsWorkflow";

type MapPlanInteractionOverlayProps = {
  visible: boolean;
  manipulationMode: PlanManipulationMode;
  onSetMode: (mode: PlanManipulationMode) => void;
  transformData: TransformHUDData;
  onTransformChange: (data: Partial<TransformHUDData>) => void;
  onConfirm: () => void;
  /** Whether any transform has been applied (shows confirm button) */
  hasTransform: boolean;
  /** Plan center position in screen coordinates for icon positioning */
  planCenter?: { x: number; y: number };
};

type IconConfig = {
  id: PlanManipulationMode;
  icon: React.ReactNode;
  label: string;
  position: { top?: number; bottom?: number; left?: number; right?: number };
};

/**
 * Floating overlay rendered on top of the map when the user taps the plan.
 * Shows 3 action icons (Scale, Drag, Rotate) and a confirm button.
 *
 * Supports two interaction modes per icon:
 * - Hold & drag: perform action while holding
 * - Tap to toggle: tap to enter mode, interact with plan, tap again to exit
 */
export function MapPlanInteractionOverlay({
  visible,
  manipulationMode,
  onSetMode,
  transformData,
  onTransformChange,
  onConfirm,
  hasTransform,
}: MapPlanInteractionOverlayProps) {
  if (!visible) return null;

  const showHUD = manipulationMode !== "idle" || hasTransform;

  const icons: IconConfig[] = [
    {
      id: "scale",
      icon: <Maximize2 size={20} />,
      label: "Scale",
      position: { bottom: 80, left: 20 },
    },
    {
      id: "drag",
      icon: <Move size={20} />,
      label: "Drag",
      position: { bottom: 80, left: 80 },
    },
    {
      id: "rotate",
      icon: <RotateCw size={20} />,
      label: "Rotate",
      position: { bottom: 80, right: 20 },
    },
  ];

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
      }}
    >
      {/* Transform HUD */}
      <TransformHUD data={transformData} visible={showHUD} />

      {/* Confirm button */}
      {hasTransform && (
        <View
          style={{
            position: "absolute",
            top: 160,
            left: "50%",
            transform: [{ translateX: -28 }],
            zIndex: 101,
          }}
        >
          <Pressable
            onPress={onConfirm}
            style={({ pressed }) => ({
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: pressed
                ? FIELDS_COLORS.confirmGreen
                : FIELDS_COLORS.confirmGreenBg,
              borderWidth: 2,
              borderColor: FIELDS_COLORS.confirmGreen,
              alignItems: "center",
              justifyContent: "center",
              elevation: 8,
              shadowColor: FIELDS_COLORS.confirmGreen,
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.4,
              shadowRadius: 8,
            })}
          >
            <Check size={28} color={FIELDS_COLORS.confirmGreen} strokeWidth={3} />
          </Pressable>
          <Text
            style={{
              textAlign: "center",
              color: FIELDS_COLORS.textMuted,
              fontSize: 9,
              fontWeight: "700",
              marginTop: 4,
              letterSpacing: 0.5,
            }}
          >
            CONFIRM
          </Text>
        </View>
      )}

      {/* Action icons */}
      {icons.map((cfg) => {
        const isActive = manipulationMode === cfg.id;
        return (
          <ActionIcon
            key={cfg.id}
            config={cfg}
            isActive={isActive}
            onTap={() => {
              onSetMode(manipulationMode === cfg.id ? "idle" : cfg.id);
            }}
          />
        );
      })}
    </View>
  );
}

function ActionIcon({
  config,
  isActive,
  onTap,
}: {
  config: IconConfig;
  isActive: boolean;
  onTap: () => void;
}) {
  return (
    <View
      style={{
        position: "absolute",
        ...config.position,
        zIndex: 52,
      }}
    >
      <Pressable
        onPress={onTap}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: isActive
            ? FIELDS_COLORS.iconGlow
            : pressed
            ? "rgba(255,255,255,0.08)"
            : FIELDS_COLORS.hudBg,
          borderWidth: 2,
          borderColor: isActive
            ? FIELDS_COLORS.iconActive
            : FIELDS_COLORS.hudBorder,
          alignItems: "center",
          justifyContent: "center",
          // Glow effect when active
          ...(isActive
            ? {
                shadowColor: FIELDS_COLORS.iconActive,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 0.6,
                shadowRadius: 12,
                elevation: 8,
              }
            : {
                elevation: 4,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.3,
                shadowRadius: 4,
              }),
        })}
      >
        {React.cloneElement(config.icon as React.ReactElement<any>, {
          color: isActive ? FIELDS_COLORS.iconActive : FIELDS_COLORS.textMuted,
        })}
      </Pressable>
      <Text
        style={{
          textAlign: "center",
          color: isActive ? FIELDS_COLORS.iconActive : FIELDS_COLORS.textDim,
          fontSize: 9,
          fontWeight: "700",
          marginTop: 3,
          letterSpacing: 0.3,
        }}
      >
        {config.label}
      </Text>
    </View>
  );
}
