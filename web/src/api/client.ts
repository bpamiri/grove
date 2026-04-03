// Grove v3 — HTTP API client

const BASE = "";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem("grove-auth-token");
  const resp = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }
  return resp.json();
}

export async function postTask(title: string, treeId?: string): Promise<any> {
  return api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title, tree_id: treeId }),
  });
}

export async function postChat(text: string): Promise<any> {
  return api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

// Skills API
export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  source?: string;
  suggested_steps?: string[];
  files: string[];
}

export async function fetchSkills(): Promise<SkillManifest[]> {
  return api<SkillManifest[]>("/api/skills");
}

export async function installSkill(source: string): Promise<{ ok: boolean; name: string }> {
  return api("/api/skills/install", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
}

export async function removeSkill(name: string): Promise<{ ok: boolean }> {
  return api(`/api/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}
