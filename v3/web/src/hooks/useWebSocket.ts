import { useState, useEffect, useRef, useCallback } from "react";

export interface WsMessage {
  type: string;
  data: any;
  ts: number;
}

interface UseWebSocketOptions {
  onMessage?: (msg: WsMessage) => void;
}

export function useWebSocket(opts?: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      reconnectDelay.current = 1000;

      // Authenticate if we have a token
      const token = localStorage.getItem("grove-auth-token");
      if (token) {
        ws.send(JSON.stringify({ type: "auth", token }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        opts?.onMessage?.(msg);
      } catch {
        // Invalid message
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Reconnect with exponential backoff
      reconnectTimer.current = globalThis.setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
        connect();
      }, reconnectDelay.current);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [opts?.onMessage]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { connected, send };
}
