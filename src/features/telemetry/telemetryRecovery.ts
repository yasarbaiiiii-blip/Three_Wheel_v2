import type { ProdApiClient } from "../../api/prodClient";
import type { HealthResponse } from "../../contract/prod/rest";
import { beginTelemetryRequest, ingestTelemetryPacket } from "./prodTelemetryStore";

/** Recovery calls are read-only. A late response cannot overwrite a newer packet or session. */
export async function recoverProductionTelemetry(client: Pick<ProdApiClient, "getTelemetry" | "health">): Promise<{accepted: boolean; health: HealthResponse | null}> {
  const request = beginTelemetryRequest();
  // Health failure must not discard a valid telemetry response.
  const health = client.health().catch(() => null);
  const packet = await client.getTelemetry();
  const accepted = ingestTelemetryPacket(packet, {source: "rest", request});
  return {accepted, health: await health};
}
