import React from "react";
import { View, Text, Pressable } from "react-native";
import AnimatedReanimated from "react-native-reanimated";
import { Menu, LayoutGrid, Crosshair, LocateFixed, Navigation as NavigationIcon, Circle, LogOut } from "lucide-react-native";

const NAV_SECTION_ITEMS = [
  { id: "main", icon: Crosshair, label: "Main Screen" },
  { id: "fields", icon: LocateFixed, label: "Fields" },
  { id: "settings", icon: NavigationIcon, label: "Settings" },
  { id: "howto", icon: Circle, label: "How to" },
];

function NavBarItem({ icon: Icon, label, active, expanded, onPress, danger = false, colors, styles }: any) {
  return (
    <Pressable
      style={[
        styles.navItem,
        expanded && styles.navItemExpanded,
        expanded && active && styles.navItemActive,
        danger && styles.navItemDanger,
      ]}
      onPress={onPress}
    >
      <View style={[
        styles.navIconWrap,
        active && !danger && styles.navIconWrapActive,
        active && !danger && !expanded && styles.navIconWrapActiveCollapsed,
        danger && styles.navIconWrapDanger,
      ]}>
        <Icon
          color={danger ? colors.danger : active ? colors.accentText : colors.textMuted}
          size={20}
          strokeWidth={2.2}
        />
      </View>
      {expanded && (
        <View style={styles.navLabelWrap}>
          <Text style={[
            styles.navLabel,
            active && !danger && styles.navLabelActive,
            danger && styles.navLabelDanger,
          ]}>
            {label}
          </Text>
          {active && !danger && <View style={styles.navActiveDot} />}
        </View>
      )}
    </Pressable>
  );
}

type NavbarProps = {
  navAnimatedStyle: any;
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
  navIconsVisible,
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
  return (
    <AnimatedReanimated.View style={[styles.navbar, navAnimatedStyle, !navIconsVisible && styles.navbarCompact]}>
      <View style={[styles.navMenuGroup, !navIconsVisible && styles.navMenuGroupCompact]}>
        <Pressable
          style={[
            styles.navMenuPressable,
            !navIconsVisible && styles.navMenuPressableCompact,
            navIconsVisible && navExpanded && styles.navItemExpanded,
            navIconsVisible && navExpanded && styles.navItemActive,
          ]}
          onPress={handleMenuPress}
        >
          {navExpanded && navIconsVisible ? (
            <>
              <View style={[styles.navIconWrap, styles.navIconWrapActive]}>
                <Menu color={colors.accentText} size={20} strokeWidth={2.2} />
              </View>
              <View style={styles.navLabelWrap}>
                <Text style={[styles.navLabel, styles.navLabelActive]}>Menu</Text>
                <View style={styles.navActiveDot} />
              </View>
            </>
          ) : (
            <View style={styles.navMenuCollapsed}>
              <View style={[
                styles.navIconWrap,
                navIconsVisible && styles.navIconWrapActive,
                !navIconsVisible && styles.navIconWrapCompact,
              ]}>
                <Menu color={navIconsVisible ? colors.accentText : colors.textMuted} size={20} strokeWidth={2.2} />
              </View>
            </View>
          )}
        </Pressable>
        {navIconsVisible && (
          <>
            <Text
              style={[styles.navFieldMarkerLabel, navExpanded && styles.navFieldMarkerLabelExpanded]}
              numberOfLines={2}
            >
              Field Marker
            </Text>
            <View style={styles.navGroupSeparator} />
          </>
        )}
      </View>

      {navIconsVisible && (
        <>
          {isHomePage ? (
            <>
              <View style={styles.navGroupSeparator} />
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
                  onPress={handleQuickAccessPress}
                  colors={colors}
                  styles={styles}
                />
              </View>
              <View style={styles.navGroupSeparator} />
            </>
          ) : null}

          <View style={styles.navSection}>
            {NAV_SECTION_ITEMS.map((item) => (
              <NavBarItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={activeNav === item.id}
                expanded={navExpanded}
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
            onPress={onCycleMapStyle}
            colors={colors}
            styles={styles}
          />

          <NavBarItem
            icon={LogOut}
            label="Exit Session"
            active={false}
            expanded={navExpanded}
            danger={true}
            onPress={onExitSession}
            colors={colors}
            styles={styles}
          />
        </>
      )}
    </AnimatedReanimated.View>
  );
}

function arePropsEqual(prev: NavbarProps, next: NavbarProps): boolean {
  // navAnimatedStyle is a Reanimated useAnimatedStyle() result: a new JS
  // object every render by design (the animation itself runs on the UI
  // thread via shared values, not via this reference), so it's deliberately
  // excluded from the comparison below.
  return (
    prev.navIconsVisible === next.navIconsVisible &&
    prev.navExpanded === next.navExpanded &&
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
