import React from "react";
import { View, Text, Pressable } from "react-native";
import AnimatedReanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { Menu, X, LayoutGrid, Crosshair, LocateFixed, Navigation as NavigationIcon, Circle, LogOut } from "lucide-react-native";

const NAV_SECTION_ITEMS = [
  { id: "main", icon: Crosshair, label: "Main Screen" },
  { id: "fields", icon: LocateFixed, label: "Fields" },
  { id: "settings", icon: NavigationIcon, label: "Settings" },
  { id: "howto", icon: Circle, label: "How to" },
];

const LABEL_WIDTH = 168;

function NavBarItem({
  icon: Icon,
  label,
  active,
  expanded,
  expandProgress,
  onPress,
  danger = false,
  colors,
  styles,
}: any) {
  const labelAnimStyle = useAnimatedStyle(() => ({
    opacity: expandProgress.value,
    width: interpolate(expandProgress.value, [0, 1], [0, LABEL_WIDTH]),
    marginLeft: interpolate(expandProgress.value, [0, 1], [0, 12]),
  }));

  return (
    <Pressable
      style={[
        styles.navItem,
        expanded && active && !danger && styles.navItemActive,
        danger && styles.navItemDanger,
      ]}
      onPress={onPress}
    >
      <View
        style={[
          styles.navIconWrap,
          active && !danger && styles.navIconWrapActive,
          danger && styles.navIconWrapDanger,
        ]}
      >
        <Icon
          color={danger ? colors.danger : active ? colors.accentText : colors.textMuted}
          size={20}
          strokeWidth={2.2}
        />
      </View>
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
        {active && !danger ? <View style={styles.navActiveDot} /> : null}
      </AnimatedReanimated.View>
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
  const menuLabelAnimStyle = useAnimatedStyle(() => ({
    opacity: navExpandProgress.value,
    width: interpolate(navExpandProgress.value, [0, 1], [0, LABEL_WIDTH]),
    marginLeft: interpolate(navExpandProgress.value, [0, 1], [0, 12]),
  }));

  const markerAnimStyle = useAnimatedStyle(() => ({
    opacity: navExpandProgress.value,
    height: interpolate(navExpandProgress.value, [0, 1], [0, 28]),
    marginTop: interpolate(navExpandProgress.value, [0, 1], [0, 6]),
    overflow: "hidden" as const,
  }));

  const MenuGlyph = navExpanded ? X : Menu;

  return (
    <AnimatedReanimated.View style={[styles.navbar, navAnimatedStyle]}>
      <View style={styles.navMenuGroup}>
        <Pressable style={styles.navMenuPressable} onPress={handleMenuPress}>
          <View style={[styles.navIconWrap, styles.navIconWrapActive]}>
            <MenuGlyph color={colors.accentText} size={20} strokeWidth={2.2} />
          </View>
          <AnimatedReanimated.View style={[styles.navLabelWrap, menuLabelAnimStyle]} pointerEvents="none">
            <Text numberOfLines={1} style={[styles.navLabel, styles.navLabelActive]}>
              Menu
            </Text>
          </AnimatedReanimated.View>
        </Pressable>

        <AnimatedReanimated.View style={markerAnimStyle} pointerEvents="none">
          <Text style={styles.navFieldMarkerLabel} numberOfLines={1}>
            Field Marker
          </Text>
          <View style={styles.navGroupSeparator} />
        </AnimatedReanimated.View>
      </View>

      <View style={styles.navRest} pointerEvents="auto">
        {isHomePage ? (
          <View
            ref={quickAccessAnchorRef}
            collapsable={false}
            onLayout={updateQuickAccessAnchor}
            style={styles.quickAccessAnchor}
          >
            <NavBarItem
              icon={LayoutGrid}
              label="Quick Access"
              active={quickAccessExpanded}
              expanded={navExpanded}
              expandProgress={navExpandProgress}
              onPress={handleQuickAccessPress}
              colors={colors}
              styles={styles}
            />
          </View>
        ) : null}

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
          icon={LayoutGrid}
          label="Cycle Map View"
          active={false}
          expanded={navExpanded}
          expandProgress={navExpandProgress}
          onPress={onCycleMapStyle}
          colors={colors}
          styles={styles}
        />

        <NavBarItem
          icon={LogOut}
          label="Exit Session"
          active={false}
          expanded={navExpanded}
          expandProgress={navExpandProgress}
          danger={true}
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
