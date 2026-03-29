// Grove v3 — HTTP API client

const BASE = "";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
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
