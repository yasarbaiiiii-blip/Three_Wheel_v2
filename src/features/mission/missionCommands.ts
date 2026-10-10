/**
 * Mission commands through the authenticated production client, and the operator message for
 * every typed error. REST is for commands only: the effect of a command is never read from its
 * answer but arrives as a `mission_state` rover event.
 *
 * Routes (backend `api/routes.py`):
 *   start   POST /api/missions/{sha}/start  {request_id}      202 accepted
 *   pause   POST /api/mission/pause                            200 {ok, code, reason, delivered, data}
 *   resume  POST /api/mission/resume
 *   stop    POST /api/mission/abort         {reason: operator}
 * Errors are `{ok:false, code, reason, delivered, data}` (gateway verdicts) or `{ok:false, code, reason}`
 * (mission store checks), or FastAPI's `{detail}` for 401 / 403 / 422.
 */

import { ProdApiError, getProdApiClient, type ProdApiClient } from "../../api/prodClient";
import type { GatewayVerdictResponse, StartMissionResponse } from "../../contract/prod/rest";
import { describeGate } from "./missionLifecycle";
import { StartTap, beginStartTap, isOutcomeUnknown } from "./startTap";

export type MissionCommand = "start" | "pause" | "resume" | "stop";

/**
 * How a failed command ended:
 *  - refused: the rover answered and said no (nothing changed);
 *  - not_delivered: the command never reached the mission node (nothing changed);
 *  - unknown: no answer in time, the command may have run: read the status on screen before acting again;
 *  - unauthorized: not signed in or not an operator;
 *  - invalid: the request itself was wrong (an app/rover mismatch);
 *  - other.
 */
export type CommandFailureKind = "refused" | "not_delivered" | "unknown" | "unauthorized" | "invalid" | "other";

export type CommandFailure = {
  ok: false;
  command: MissionCommand;
  kind: CommandFailureKind;
  title: string;
  message: string;
  code: string;
  /** The mission node's refusal reason (`data.reason_code`), when it gave one. */
  reasonCode: number | null;
};

export type CommandSuccess = {
  ok: true;
  command: MissionCommand;
  message: string;
  /** Start only: the execution id the rover accepted. */
  missionId?: number | null;
  /** Start only: the rover already had this request id, so nothing new was started. */
  duplicate?: boolean;
  requestId?: string;
};

export type CommandResult = CommandSuccess | CommandFailure;

/** Carries a CommandFailure through a try/catch so the caller can show title and message once. */
export class CommandFailedError extends Error {
  readonly failure: CommandFailure;
  constructor(failure: CommandFailure) {
    super(failure.message);
    this.name = "CommandFailedError";
    this.failure = failure;
  }
}

const TITLES: Record<MissionCommand, string> = {
  start: "Start failed",
  pause: "Pause failed",
  resume: "Resume failed",
  stop: "Stop failed",
};

/** Refusal reasons of the mission node's services, per command (srv/*.srv REASON_*). */
function refusalText(command: MissionCommand, reasonCode: number, gate: number | null): string | null {
  switch (command) {
    case "start":
      switch (reasonCode) {
        case 1:
          return "The rover does not accept this mission id. Send the mission again.";
        case 2:
          return "The rover is still running the previous mission or releasing it (OFFBOARD, disarm). Wait until it has finished, then start again.";
        case 3:
          return `The rover's safety checks do not allow a start${gate ? `: ${describeGate(gate)}` : ""}.`;
        case 4:
          return "The rover rejected the request id. This is an app/rover mismatch: report it.";
        default:
          return null;
      }
    case "pause":
      if (reasonCode === 1) return "The mission is not running, so there is nothing to pause.";
      if (reasonCode === 2) return "The rover's safety checks do not allow a pause right now.";
      return null;
    case "resume":
      switch (reasonCode) {
        case 1:
          return "The mission is not paused, so there is nothing to resume.";
        case 2:
          return "The rover's safety checks do not allow resuming yet. Clear the cause, then resume.";
        case 3:
          return "The rover is no longer armed or in OFFBOARD. Stop the mission and start it again.";
        case 4:
          return "The rover's GPS reference changed since the mission was placed, so the path no longer lies where it was drawn. Stop the mission and start it again.";
        default:
          return null;
      }
    case "stop":
      if (reasonCode === 1) return "No mission is active, so there is nothing to stop.";
      return null;
  }
}

function dataNumber(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Operator message for anything thrown while sending a mission command. */
export function describeCommandError(command: MissionCommand, err: unknown): CommandFailure {
  const title = TITLES[command];
  if (!(err instanceof ProdApiError)) {
    const message = err instanceof Error && err.message ? err.message : "The command could not be sent.";
    return { ok: false, command, kind: "other", title, message, code: "ERROR", reasonCode: null };
  }
  const code = err.code;
  const reasonCode = dataNumber(err.data, "reason_code");
  const gate = dataNumber(err.data, "gate_reason_code");
  const fail = (kind: CommandFailureKind, message: string): CommandFailure => ({
    ok: false,
    command,
    kind,
    title,
    message,
    code,
    reasonCode,
  });

  if (code === "HTTP_401") return fail("unauthorized", "Not signed in to the rover. Sign in again, then retry.");
  if (code === "HTTP_403") {
    return fail("unauthorized", "This account is not allowed to control missions (operator role required).");
  }

  if (code === "rejected") {
    const text = reasonCode !== null ? refusalText(command, reasonCode, gate) : null;
    return fail("refused", text ?? `The rover refused the command${err.reason ? `: ${err.reason}` : ""}.`);
  }
  if (code === "invalid_command") {
    const text = reasonCode !== null ? refusalText(command, reasonCode, gate) : null;
    return fail("invalid", text ?? "The rover could not read the command. This is an app/rover mismatch: report it.");
  }
  if (code === "invalid_request_id" || code === "HTTP_422") {
    return fail("invalid", "The request was not valid for the rover. This is an app/rover mismatch: report it.");
  }
  if (code === "bad_id") return fail("invalid", "The mission id is not valid. Send the mission again.");
  if (code === "not_found" || err.status === 404) {
    return fail("refused", "The rover has no stored mission with this id. Send the mission again.");
  }

  // No verdict in time: the command may or may not have run.
  if (isOutcomeUnknown(err) || code === "timeout" || code === "GatewayTimeout" || code === "TIMEOUT" || code === "NETWORK_ERROR") {
    const watch = "Watch the mission status on screen before sending anything else.";
    if (command === "start") {
      return fail("unknown", `The rover did not confirm the start in time, so it may be starting. ${watch}`);
    }
    return fail("unknown", `The rover did not confirm the ${command} in time, so it may have run. ${watch}`);
  }

  // The command was NOT delivered: the backend has no gateway link, or the service is down or busy.
  if (code === "GatewayUnavailable" || code === "service_unavailable" || code === "busy" || err.delivered === false) {
    return fail(
      "not_delivered",
      code === "busy"
        ? "The rover's mission service is busy. Nothing was changed; try again in a moment."
        : "The command did not reach the rover's mission controller. Nothing was changed. Check the rover link, then try again."
    );
  }

  return fail("other", err.reason || err.message || "The command failed.");
}

type CommandClient = Pick<ProdApiClient, "pauseMission" | "resumeMission" | "abortMission" | "startMission">;

/** A 2xx body with `ok:false` is still a refusal; treat it like the typed error it is. */
function verdictToError(verdict: GatewayVerdictResponse): ProdApiError {
  return new ProdApiError(verdict.reason, 200, verdict.code, verdict.reason, verdict.delivered, verdict.data);
}

/** Pause the running mission. The state change arrives as a `mission_state` event. */
export async function pauseMissionCommand(client: CommandClient = getProdApiClient()): Promise<CommandResult> {
  try {
    const verdict = await client.pauseMission();
    if (!verdict.ok) return describeCommandError("pause", verdictToError(verdict));
    return { ok: true, command: "pause", message: "Pause requested." };
  } catch (err) {
    return describeCommandError("pause", err);
  }
}

/** Resume a paused mission (never automatic). */
export async function resumeMissionCommand(client: CommandClient = getProdApiClient()): Promise<CommandResult> {
  try {
    const verdict = await client.resumeMission();
    if (!verdict.ok) return describeCommandError("resume", verdictToError(verdict));
    return { ok: true, command: "resume", message: "Resume requested." };
  } catch (err) {
    return describeCommandError("resume", err);
  }
}

/** The operator's Stop: abort the active mission with reason `operator`. */
export async function stopMissionCommand(client: CommandClient = getProdApiClient()): Promise<CommandResult> {
  try {
    const verdict = await client.abortMission("operator");
    if (!verdict.ok) return describeCommandError("stop", verdictToError(verdict));
    return { ok: true, command: "stop", message: "Stop requested." };
  } catch (err) {
    return describeCommandError("stop", err);
  }
}

/**
 * Start the stored mission `tap.sha`. One tap = one request id; the id is reused if the outcome
 * is unknown and the send is repeated. 202 means accepted, nothing more: the lifecycle arrives
 * as events.
 */
export async function startMissionCommand(
  tap: StartTap,
  client: CommandClient = getProdApiClient()
): Promise<CommandResult> {
  try {
    const res: StartMissionResponse = await tap.submit(client);
    const duplicate = res.execution?.duplicate === true || res.data?.duplicate === true;
    return {
      ok: true,
      command: "start",
      message: duplicate
        ? "The rover already has this start; nothing new was started."
        : "Start accepted. Watching the rover's progress.",
      missionId: res.execution?.mission_id ?? res.data?.mission_id ?? null,
      duplicate,
      requestId: tap.requestId,
    };
  } catch (err) {
    return describeCommandError("start", err);
  }
}

export { beginStartTap };
