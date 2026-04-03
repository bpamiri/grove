import { useState, useEffect, useCallback } from "react";
import type { WsMessage } from "./useWebSocket";
import { fetchSkills, installSkill, removeSkill, type SkillManifest } from "../api/client";

export function useSkills() {
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchSkills();
      setSkills(data);
    } catch {
      // API not available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleWsMessage = useCallback(
    (msg: WsMessage) => {
      if (msg.type === "skill:installed" || msg.type === "skill:removed") {
        refresh();
      }
    },
    [refresh],
  );

  const install = useCallback(
    async (source: string) => {
      const res = await installSkill(source);
      return res;
    },
    [],
  );

  const remove = useCallback(
    async (name: string) => {
      await removeSkill(name);
    },
    [],
  );

  return { skills, loading, refresh, install, remove, handleWsMessage };
}
