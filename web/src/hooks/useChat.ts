import { useState, useEffect, useCallback, useRef } from "react";
import type { WsMessage } from "./useWebSocket";
import { api } from "../api/client";

export interface ChatMessage {
  id: number;
  source: string;
  channel: string;
  content: string;
  created_at: string;
}

export function useChat(send: (data: any) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load initial messages
  useEffect(() => {
    api<ChatMessage[]>("/api/messages?channel=main&limit=50")
      .then(msgs => setMessages(msgs.reverse()))
      .catch(() => {});
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === "message:new") {
      setMessages(prev => [...prev, msg.data.message]);
    }
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    // Message will appear when the server broadcasts it back via WebSocket
    send({ type: "chat", text });
  }, [send]);

  return { messages, sendMessage, handleWsMessage, bottomRef };
}
