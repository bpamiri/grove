import { useState, useCallback, useEffect, useRef } from "react";
import type { WsMessage } from "./useWebSocket";
import { api } from "../api/client";

export interface SeedMessage {
  source: "ai" | "user";
  content: string;
  html?: string;
}

export interface Seed {
  task_id: string;
  summary: string | null;
  spec: string | null;
  status: string;
  active: boolean;
  conversation: SeedMessage[];
}

export function useSeed(taskId: string | null, send: (data: any) => void) {
  const [seed, setSeed] = useState<Seed | null>(null);
  const [messages, setMessages] = useState<SeedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadSeed = useCallback(async (tid: string) => {
    setLoading(true);
    try {
      const data = await api<Seed | null>(`/api/tasks/${tid}/seed`);
      if (data) {
        setSeed(data);
        setMessages(data.conversation || []);
      } else {
        setSeed(null);
        setMessages([]);
      }
    } catch {
      setSeed(null);
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (taskId) loadSeed(taskId);
    else { setSeed(null); setMessages([]); }
  }, [taskId, loadSeed]);

  const startSeed = useCallback(() => {
    if (!taskId) return;
    send({ type: "seed_start", taskId });
    setSeed(prev => prev ? { ...prev, active: true, status: "active" } : {
      task_id: taskId, summary: null, spec: null, status: "active", active: true, conversation: [],
    });
  }, [taskId, send]);

  const stopSeed = useCallback(() => {
    if (!taskId) return;
    send({ type: "seed_stop", taskId });
    setSeed(prev => prev ? { ...prev, active: false } : null);
  }, [taskId, send]);

  const sendMessage = useCallback((text: string) => {
    if (!taskId) return;
    send({ type: "seed", taskId, text });
  }, [taskId, send]);

  const discardSeed = useCallback(async () => {
    if (!taskId) return;
    try {
      await api(`/api/tasks/${taskId}/seed`, { method: "DELETE" });
      setSeed(null);
      setMessages([]);
    } catch {}
  }, [taskId]);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (!taskId) return;

    if (msg.type === "seed:message" && msg.data?.taskId === taskId) {
      const newMsg: SeedMessage = {
        source: msg.data.source,
        content: msg.data.content,
        html: msg.data.html,
      };
      setMessages(prev => [...prev, newMsg]);
    }

    if (msg.type === "seed:started" && msg.data?.taskId === taskId) {
      setSeed(prev => prev ? { ...prev, active: true, status: "active" } : {
        task_id: taskId, summary: null, spec: null, status: "active", active: true, conversation: [],
      });
    }

    if (msg.type === "seed:complete" && msg.data?.taskId === taskId) {
      setSeed(prev => prev ? {
        ...prev, active: false, status: "completed",
        summary: msg.data.seed.summary, spec: msg.data.seed.spec,
      } : null);
    }

    if (msg.type === "seed:stopped" && msg.data?.taskId === taskId) {
      setSeed(prev => prev ? { ...prev, active: false } : null);
    }
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return {
    seed, messages, loading, bottomRef,
    startSeed, stopSeed, sendMessage, discardSeed, handleWsMessage,
    isActive: seed?.active ?? false,
    isSeeded: seed?.status === "completed",
  };
}
