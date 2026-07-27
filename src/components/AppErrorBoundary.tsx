import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type Props = {
  children: React.ReactNode;
  /** Short label for logs (e.g. "MapView", "Home"). */
  name?: string;
  /** Optional fallback UI; default is a recoverable error card. */
  fallback?: React.ReactNode;
  onReset?: () => void;
};

type State = { error: Error | null };

/**
 * Catches render/lifecycle JS errors so a single bad subtree (often Mapbox after
 * websocket connect) does not force-close the whole release APK.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const label = this.props.name ?? "App";
    console.error(`[ErrorBoundary:${label}]`, error?.message ?? error, info?.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <View style={styles.box}>
          <Text style={styles.title}>Something went wrong{this.props.name ? ` (${this.props.name})` : ""}</Text>
          <Text style={styles.msg} numberOfLines={6}>
            {this.state.error.message || String(this.state.error)}
          </Text>
          <Pressable onPress={this.reset} style={styles.btn}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  box: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0f172a",
    gap: 12,
  },
  title: { color: "#f8fafc", fontSize: 16, fontWeight: "800", textAlign: "center" },
  msg: { color: "#94a3b8", fontSize: 12, textAlign: "center", lineHeight: 18 },
  btn: {
    marginTop: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#2563eb",
  },
  btnText: { color: "#fff", fontWeight: "800", fontSize: 13 },
});
