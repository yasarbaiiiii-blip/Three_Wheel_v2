/**
 * One user tap on Start = one `request_id`.
 *
 * The id is the idempotency key of `POST /api/missions/{sha}/start`: the rover returns the
 * existing execution (`duplicate: true`) for a repeated id, so a retry of the SAME tap can never
 * start a second run. A NEW tap always gets a NEW id, otherwise a later, deliberate Start would
 * be answered as a duplicate and start nothing.
 *
 * A retry only happens when the first attempt's outcome is unknown (no answer in time, or the
 * link dropped). A refusal ("rejected", "not delivered") is final for the tap: the operator
 * fixes the cause and taps again.
 */

import { ProdApiError } from "../../api/prodClient";
import type { StartMissionResponse } from "../../contract/prod/rest";

/** The rover accepts 1-64 characters of A-Z a-z 0-9 . _ : - (backend contract 1c). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

let counter = 0;

/**
 * A fresh id: `app-<ms in base 36>-<counter>-<random>`. The counter keeps two taps in the same
 * millisecond apart; the random part keeps two tablets apart.
 */
export function newRequestId(now: () => number = Date.now, random: () => number = Math.random): string {
  counter = (counter + 1) % 0x7fffffff;
  const rnd = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `app-${Math.floor(now()).toString(36)}-${counter.toString(36)}-${rnd}`;
}

/** True when the command may or may not have reached the mission node (no verdict, delivered unknown). */
export function isOutcomeUnknown(err: unknown): boolean {
  return err instanceof ProdApiError && err.delivered === null;
}

export interface StartClient {
  startMission(sha: string, requestId: string): Promise<StartMissionResponse>;
}

export class StartTap {
  readonly sha: string;
  readonly requestId: string;
  /** Requests sent for this tap (1 normally, 2 after a retry). */
  attempts = 0;

  constructor(sha: string, requestId: string = newRequestId()) {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error(`Invalid request id: ${requestId}`);
    }
    this.sha = sha;
    this.requestId = requestId;
  }

  /**
   * Send the start. When the outcome is unknown, send it once more with the same id (up to
   * `maxAttempts` requests in total). Any other failure is thrown at once.
   */
  async submit(client: StartClient, opts: { maxAttempts?: number } = {}): Promise<StartMissionResponse> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
    for (;;) {
      this.attempts += 1;
      try {
        return await client.startMission(this.sha, this.requestId);
      } catch (err) {
        if (!isOutcomeUnknown(err) || this.attempts >= maxAttempts) throw err;
      }
    }
  }
}

export function beginStartTap(sha: string): StartTap {
  return new StartTap(sha);
}
