/**
 * What the link strip of the mission screen shows for the four link-like kinds.
 *
 * Every chip is tri-state: ok, bad, or unknown. Unknown is its own colour and word, never a
 * green "OK" kept from before: with the gateway link down, or no socket, or a silent source,
 * nothing but the gateway chip itself is known.
 */

import {
  describeUnknown,
  selectEstop,
  selectFcuLink,
  selectGatewayLink,
  selectOperatorLink,
  type RoverEventsState,
} from "./roverEventStore";

export type LinkTone = "ok" | "bad" | "unknown";

export type LinkChip = {
  key: "gateway" | "operator" | "fcu" | "estop";
  label: string;
  value: string;
  tone: LinkTone;
};

export function describeRoverLinks(s: RoverEventsState): LinkChip[] {
  const gateway = selectGatewayLink(s);
  const operator = selectOperatorLink(s);
  const fcu = selectFcuLink(s);
  const estop = selectEstop(s);

  const chips: LinkChip[] = [];

  chips.push(
    gateway.known
      ? { key: "gateway", label: "Rover", value: gateway.connected ? "ONLINE" : "CONTROLLER OFFLINE", tone: gateway.connected ? "ok" : "bad" }
      : { key: "gateway", label: "Rover", value: "NO LINK", tone: "unknown" }
  );
  chips.push(
    operator.known
      ? { key: "operator", label: "Operator link", value: operator.alive ? "ALIVE" : "LOST", tone: operator.alive ? "ok" : "bad" }
      : { key: "operator", label: "Operator link", value: "UNKNOWN", tone: "unknown" }
  );
  chips.push(
    fcu.known
      ? { key: "fcu", label: "Flight controller", value: fcu.healthy ? "CONNECTED" : "NOT CONNECTED", tone: fcu.healthy ? "ok" : "bad" }
      : { key: "fcu", label: "Flight controller", value: "UNKNOWN", tone: "unknown" }
  );
  chips.push(
    estop.known
      ? { key: "estop", label: "E-stop", value: estop.asserted ? "ASSERTED" : "CLEAR", tone: estop.asserted ? "bad" : "ok" }
      : { key: "estop", label: "E-stop", value: "UNKNOWN", tone: "unknown" }
  );
  return chips;
}

/** One line for why the links are unknown, or null when the gateway link itself is known and up. */
export function linkUnknownNote(s: RoverEventsState): string | null {
  const gateway = selectGatewayLink(s);
  if (!gateway.known) return describeUnknown(gateway.reason);
  if (!gateway.connected) return describeUnknown("gateway_down");
  return null;
}
