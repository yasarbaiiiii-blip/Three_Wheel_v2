import React from "react";
import { View, Text, Pressable } from "react-native";
import AnimatedReanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import {
  Crosshair,
  LocateFixed,
  Settings,
  CircleHelp,
  Layers,
  LogOut,
} from "lucide-react-native";

import { usePressScale } from "./fields/usePressScale";

const NAV_SECTION_ITEMS = [
  { id: "main", icon: Crosshair, label: "Home" },
  { id: "fields", icon: LocateFixed, label: "Fields" },
  { id: "settings", icon: Settings, label: "Settings" },
  { id: "howto", icon: CircleHelp, label: "How to" },
];

const LABEL_WIDTH = 148;

function NavBarItem({
  icon: Icon,
  label,
  active,
  expanded,
  expandProgress,
  onPress,
  danger = false,
  disclosure = false,
  open = false,
  colors,
  styles,
}: any) {
  const labelAnimStyle = useAnimatedStyle(() => ({
    opacity: expanded ? 1 : interpolate(expandProgress.value, [0, 0.15, 1], [0, 1, 1]),
    width: interpolate(expandProgress.value, [0, 1], [0, LABEL_WIDTH]),
    marginLeft: interpolate(expandProgress.value, [0, 1], [0, 12]),
  }));
  const { style: pressStyle, onPressIn, onPressOut } = usePressScale(0.94);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityState={{ selected: active, expanded: disclosure ? !!open : undefined }}
      accessibilityLabel={disclosure ? `${label}, submenu` : label}
      android_ripple={{ color: "rgba(255,255,255,0.08)", borderless: true, radius: 26 }}
    >
      <View
        style={[
          styles.navItem,
          expanded && active && !danger && !disclosure && styles.navItemActive,
        ]}
      >
        {disclosure ? (
          <AnimatedReanimated.View style={[styles.navSubmenuSlot, pressStyle]}>
            <View style={[styles.navSubmenuPill, open && styles.navSubmenuPillOpen]}>
              <View style={[styles.navSubmenuDot, open && styles.navSubmenuDotOpen]} />
              <View style={[styles.navSubmenuDot, styles.navSubmenuDotMid, open && styles.navSubmenuDotOpen]} />
              <View style={[styles.navSubmenuDot, open && styles.navSubmenuDotOpen]} />
            </View>
          </AnimatedReanimated.View>
        ) : (
          <AnimatedReanimated.View
            style={[
              styles.navIconWrap,
              active && !danger && styles.navIconWrapActive,
              danger && styles.navIconWrapDanger,
              pressStyle,
            ]}
          >
            <Icon
              color={danger ? colors.danger : active ? colors.accentText : "#e4e4e7"}
              size={20}
              strokeWidth={active ? 2.4 : 2.1}
            />
          </AnimatedReanimated.View>
        )}
        <AnimatedReanimated.View style={[styles.navLabelWrap, labelAnimStyle]} pointerEvents="none">
          <Text
            numberOfLines={1}
            style={[
              styles.navLabel,
              active && !danger && styles.navLabelActive,
              danger && styles.navLabelDanger,
            ]}
          >
            {label}
          </Text>
        </AnimatedReanimated.View>
      </View>
    </Pressable>
  );
}

type NavbarProps = {
  navAnimatedStyle: any;
  navExpandProgress: any;
  navCompactProgress: any;
  navIconsVisible: boolean;
  navExpanded: boolean;
  isHomePage: boolean;
  activeNav: string;
  quickAccessExpanded: boolean;
  quickAccessAnchorRef: React.RefObject<any>;
  handleMenuPress: () => void;
  handleQuickAccessPress: () => void;
  handleNavItemPress: (id: string) => void;
  updateQuickAccessAnchor: () => void;
  onCycleMapStyle: () => void;
  onExitSession: () => void;
  colors: any;
  styles: any;
};

function NavbarImpl({
  navAnimatedStyle,
  navExpandProgress,
  navExpanded,
  isHomePage,
  activeNav,
  quickAccessExpanded,
  quickAccessAnchorRef,
  handleMenuPress,
  handleQuickAccessPress,
  handleNavItemPress,
  updateQuickAccessAnchor,
  onCycleMapStyle,
  onExitSession,
  colors,
  styles,
}: NavbarProps) {
  const brandLabelStyle = useAnimatedStyle(() => ({
    opacity: navExpanded ? 1 : interpolate(navExpandProgress.value, [0, 0.15, 1], [0, 1, 1]),
    width: interpolate(navExpandProgress.value, [0, 1], [0, LABEL_WIDTH]),
    marginLeft: interpolate(navExpandProgress.value, [0, 1], [0, 12]),
  }));
  const { style: brandPress, onPressIn, onPressOut } = usePressScale(0.94);

  return (
    <AnimatedReanimated.View style={[styles.navbar, navAnimatedStyle]}>
      <View style={styles.navMenuGroup}>
        <Pressable
          onPress={handleMenuPress}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          accessibilityRole="button"
          accessibilityLabel={navExpanded ? "Collapse menu" : "Expand menu"}
          android_ripple={{ color: "rgba(255,255,255,0.08)", borderless: true, radius: 26 }}
        >
          <View style={styles.navMenuPressable}>
            <AnimatedReanimated.View style={[styles.navIconWrap, styles.navBrandWrap, brandPress]}>
              <Text style={styles.navBrandMark}>R</Text>
            </AnimatedReanimated.View>
            <AnimatedReanimated.View style={[styles.navLabelWrap, brandLabelStyle]} pointerEvents="none">
              <Text numberOfLines={1} style={[styles.navLabel, styles.navLabelBrand]}>
                Rover
              </Text>
            </AnimatedReanimated.View>
          </View>
        </Pressable>
        {isHomePage ? (
          <View
            ref={quickAccessAnchorRef}
            collapsable={false}
            onLayout={updateQuickAccessAnchor}
            style={styles.quickAccessAnchor}
          >
            <NavBarItem
              label="Quick Access"
              active={quickAccessExpanded}
              disclosure
              open={quickAccessExpanded}
              expanded={navExpanded}
              expandProgress={navExpandProgress}
              onPress={handleQuickAccessPress}
              colors={colors}
              styles={styles}
            />
          </View>
        ) : null}
      </View>

      <View style={styles.navRest} pointerEvents="auto">
        <View style={styles.navSection}>
          {NAV_SECTION_ITEMS.map((item) => (
            <NavBarItem
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={activeNav === item.id}
              expanded={navExpanded}
              expandProgress={navExpandProgress}
              onPress={() => handleNavItemPress(item.id)}
              colors={colors}
              styles={styles}
            />
          ))}
        </View>

        <View style={{ flex: 1 }} />

        <View style={styles.navDivider} />

        <NavBarItem
          icon={Layers}
          label="Map"
          active={false}
          expanded={navExpanded}
          expandProgress={navExpandProgress}
          onPress={onCycleMapStyle}
          colors={colors}
          styles={styles}
        />

        <NavBarItem
          icon={LogOut}
          label="Exit"
          active={false}
          expanded={navExpanded}
          expandProgress={navExpandProgress}
          danger
          onPress={onExitSession}
          colors={colors}
          styles={styles}
        />
      </View>
    </AnimatedReanimated.View>
  );
}

function arePropsEqual(prev: NavbarProps, next: NavbarProps): boolean {
  return (
    prev.navIconsVisible === next.navIconsVisible &&
    prev.navExpanded === next.navExpanded &&
    prev.navExpandProgress === next.navExpandProgress &&
    prev.navCompactProgress === next.navCompactProgress &&
    prev.isHomePage === next.isHomePage &&
    prev.activeNav === next.activeNav &&
    prev.quickAccessExpanded === next.quickAccessExpanded &&
    prev.quickAccessAnchorRef === next.quickAccessAnchorRef &&
    prev.handleMenuPress === next.handleMenuPress &&
    prev.handleQuickAccessPress === next.handleQuickAccessPress &&
    prev.handleNavItemPress === next.handleNavItemPress &&
    prev.updateQuickAccessAnchor === next.updateQuickAccessAnchor &&
    prev.onCycleMapStyle === next.onCycleMapStyle &&
    prev.onExitSession === next.onExitSession &&
    prev.colors === next.colors &&
    prev.styles === next.styles
  );
}

export const Navbar = React.memo(NavbarImpl, arePropsEqual);
export default Navbar;
