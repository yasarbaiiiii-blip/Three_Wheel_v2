export type ManualControlPayload = {
  forward: number;
  yaw: number;
};

export type ManualControlResponse = {
  success: boolean;
  message: string;
};

function apiUrl(apiBaseUrl: string, path: string) {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

export function sendManualControl(
  apiBaseUrl: string,
  payload: ManualControlPayload
): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/manual_control"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
}