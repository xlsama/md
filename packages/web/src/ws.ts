import { serverMessageSchema, type ClientMessage, type ServerMessage } from 'mdopen/protocol';

const RECONNECT_DELAY = 1000;

export interface WsClientOptions {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
}

export interface WsClient {
  send: (msg: ClientMessage) => void;
  close: () => void;
}

function wsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/**
 * WebSocket client with a flat 1s reconnect backoff.
 *
 * Incoming frames are validated against the daemon's own zod schemas, so a
 * protocol drift between the two packages surfaces as a console warning
 * instead of a mystery crash deep in the editor bridge.
 *
 * Messages sent while offline are dropped on purpose: after a reconnect the
 * daemon replays a full `workspace` message and the app resets from it, so
 * replaying a write based on pre-disconnect state would be unsafe.
 */
export function createWsClient({ onMessage, onOpen, onClose }: WsClientOptions): WsClient {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const connect = (): void => {
    if (disposed) return;
    const next = new WebSocket(wsUrl());
    socket = next;

    next.addEventListener('open', () => {
      if (socket === next) onOpen();
    });

    next.addEventListener('message', (event: MessageEvent<string>) => {
      if (socket !== next) return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        console.warn('[md] dropped malformed frame');
        return;
      }
      const parsed = serverMessageSchema.safeParse(json);
      if (!parsed.success) {
        console.warn('[md] dropped unknown message', parsed.error.issues);
        return;
      }
      onMessage(parsed.data);
    });

    const scheduleReconnect = (): void => {
      if (disposed || socket !== next) return;
      socket = null;
      onClose();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(connect, RECONNECT_DELAY);
    };

    next.addEventListener('close', scheduleReconnect);
    next.addEventListener('error', () => {
      next.close();
    });
  };

  connect();

  return {
    send(msg) {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(msg));
    },
    close() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}
