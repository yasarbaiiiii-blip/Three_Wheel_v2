import type { Socket } from "socket.io-client";

export const SOCKET_CONNECT_TIMEOUT_MS = 25000;

export function waitForSocketConnect(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      resolve();
      return;
    }
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.disconnect();
      reject(new Error("Socket connection timed out. Check Wi-Fi and rover backend."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    }

    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
  });
}

export function formatSocketConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthor/i.test(message)) {
    return "Authentication failed. The rover may have restarted — enter the password and connect again.";
  }
  return message || "Unable to connect";
}
