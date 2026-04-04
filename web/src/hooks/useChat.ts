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
  const [thinking, setThinking] = useState(false);
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
      const source = msg.data.message?.source;
      setMessages(prev => [...prev, msg.data.message]);
      // Orchestrator replied — stop showing thinking indicator
      if (source === "orchestrator") {
        setThinking(false);
      }
    }
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!text.trim()) return;
    setThinking(true);
    send({ type: "chat", text });
  }, [send]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setThinking(false);
  }, []);

  return { messages, sendMessage, handleWsMessage, bottomRef, thinking, clearMessages };
}
