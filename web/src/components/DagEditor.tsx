import { useCallback, useEffect, useState, useMemo } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../api/client";

interface DagData {
  nodes: Array<{ id: string; title: string; status: string }>;
  edges: Array<{ from_task: string; to_task: string; edge_type: string }>;
}

interface WavePlan {
  treeId: string;
  waves: Array<{ wave: number; taskIds: string[] }>;
  taskWaves: Record<string, number>;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#52525b",
  queued: "#3b82f6",
  active: "#eab308",
  completed: "#22c55e",
  failed: "#ef4444",
};

// Distinct wave colors for node borders/accents
const WAVE_COLORS = [
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f59e0b", // amber
  "#ec4899", // pink
  "#10b981", // emerald
  "#f97316", // orange
  "#6366f1", // indigo
  "#14b8a6", // teal
];

function waveColor(wave: number): string {
  return WAVE_COLORS[(wave - 1) % WAVE_COLORS.length];
}

// Layout constants
const WAVE_GAP = 300;     // horizontal spacing between wave columns
const NODE_GAP_Y = 100;   // vertical spacing between nodes in a wave
const WAVE_LABEL_H = 40;  // space for wave header
const PADDING_X = 60;
const PADDING_Y = 60;

export default function DagEditor({
  onSelectTask,
  treeId,
}: {
  onSelectTask?: (id: string) => void;
  treeId?: string | null;
}) {
  const [dagData, setDagData] = useState<DagData | null>(null);
  const [wavePlan, setWavePlan] = useState<WavePlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDag = useCallback(async () => {
    try {
      const dagUrl = treeId ? `/api/tasks/dag?treeId=${treeId}` : "/api/tasks/dag";
      const data = await api<DagData>(dagUrl);
      setDagData(data);
      setError(null);
    } catch {
      setError("Failed to load DAG");
    }
  }, [treeId]);

  // Load wave plan when a tree is selected
  const loadWavePlan = useCallback(async () => {
    if (!treeId) {
      setWavePlan(null);
      return;
    }
    try {
      const plan = await api<WavePlan>(`/api/batch/plan?treeId=${treeId}`);
      setWavePlan(plan);
    } catch {
      // Wave plan is optional — fail silently
      setWavePlan(null);
    }
  }, [treeId]);

  useEffect(() => { loadDag(); }, [loadDag]);
  useEffect(() => { loadWavePlan(); }, [loadWavePlan]);

  const { flowNodes, flowEdges, waveCount } = useMemo(() => {
    if (!dagData) return { flowNodes: [] as Node[], flowEdges: [] as Edge[], waveCount: 0 };

    const taskWaves = wavePlan?.taskWaves ?? {};
    const hasWaves = Object.keys(taskWaves).length > 0;

    let nodes: Node[];

    if (hasWaves) {
      // Group nodes by wave
      const waveGroups = new Map<number, typeof dagData.nodes>();
      const unassigned: typeof dagData.nodes = [];

      for (const n of dagData.nodes) {
        const wave = taskWaves[n.id];
        if (wave) {
          if (!waveGroups.has(wave)) waveGroups.set(wave, []);
          waveGroups.get(wave)!.push(n);
        } else {
          unassigned.push(n);
        }
      }

      const sortedWaves = [...waveGroups.keys()].sort((a, b) => a - b);
      nodes = [];

      // Wave lane labels (non-interactive annotation nodes)
      for (let i = 0; i < sortedWaves.length; i++) {
        const wave = sortedWaves[i];
        nodes.push({
          id: `__wave_label_${wave}`,
          type: "default",
          data: { label: `Wave ${wave}` },
          position: { x: PADDING_X + i * WAVE_GAP, y: PADDING_Y - WAVE_LABEL_H },
          selectable: false,
          draggable: false,
          connectable: false,
          style: {
            background: "transparent",
            border: `2px dashed ${waveColor(wave)}40`,
            borderRadius: "6px",
            color: waveColor(wave),
            fontSize: "11px",
            fontWeight: 600,
            textTransform: "uppercase" as const,
            letterSpacing: "0.05em",
            padding: "4px 12px",
            minWidth: "220px",
            textAlign: "center" as const,
          },
        });
      }

      // Position task nodes in wave columns
      for (let i = 0; i < sortedWaves.length; i++) {
        const wave = sortedWaves[i];
        const group = waveGroups.get(wave)!;
        for (let j = 0; j < group.length; j++) {
          const n = group[j];
          nodes.push({
            id: n.id,
            data: { label: `${n.id}: ${n.title.slice(0, 30)}` },
            position: {
              x: PADDING_X + i * WAVE_GAP,
              y: PADDING_Y + j * NODE_GAP_Y,
            },
            style: {
              background: STATUS_COLORS[n.status] ?? "#52525b",
              color: "#fff",
              border: `2px solid ${waveColor(wave)}`,
              borderRadius: "8px",
              padding: "8px 12px",
              fontSize: "12px",
              minWidth: "180px",
              boxShadow: `0 0 8px ${waveColor(wave)}30`,
            },
          });
        }
      }

      // Unassigned nodes in a column after all waves
      if (unassigned.length > 0) {
        const col = sortedWaves.length;
        for (let j = 0; j < unassigned.length; j++) {
          const n = unassigned[j];
          nodes.push({
            id: n.id,
            data: { label: `${n.id}: ${n.title.slice(0, 30)}` },
            position: {
              x: PADDING_X + col * WAVE_GAP,
              y: PADDING_Y + j * NODE_GAP_Y,
            },
            style: {
              background: STATUS_COLORS[n.status] ?? "#52525b",
              color: "#fff",
              border: "1px solid #3f3f46",
              borderRadius: "8px",
              padding: "8px 12px",
              fontSize: "12px",
              minWidth: "180px",
            },
          });
        }
      }
    } else {
      // Fallback: grid layout (no wave data)
      nodes = dagData.nodes.map((n, i) => ({
        id: n.id,
        data: { label: `${n.id}: ${n.title.slice(0, 30)}` },
        position: { x: PADDING_X + (i % 4) * 250, y: PADDING_Y + Math.floor(i / 4) * 120 },
        style: {
          background: STATUS_COLORS[n.status] ?? "#52525b",
          color: "#fff",
          border: "1px solid #3f3f46",
          borderRadius: "8px",
          padding: "8px 12px",
          fontSize: "12px",
          minWidth: "180px",
        },
      }));
    }

    const edges: Edge[] = dagData.edges.map(e => ({
      id: `${e.from_task}-${e.to_task}`,
      source: e.from_task,
      target: e.to_task,
      animated: e.edge_type === "dependency",
      style: { stroke: e.edge_type === "on_failure" ? "#ef4444" : "#6b7280" },
      markerEnd: { type: MarkerType.ArrowClosed },
    }));

    return { flowNodes: nodes, flowEdges: edges, waveCount: wavePlan?.waves.length ?? 0 };
  }, [dagData, wavePlan]);

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  useEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  const onConnect = useCallback(async (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    try {
      const result = await api<{ ok?: boolean; error?: string }>("/api/tasks/edges", {
        method: "POST",
        body: JSON.stringify({ from: connection.source, to: connection.target }),
      });
      if (result.error) {
        setError(result.error);
        setTimeout(() => setError(null), 3000);
        return;
      }
      setEdges(eds => addEdge({ ...connection, animated: true, markerEnd: { type: MarkerType.ArrowClosed } }, eds));
    } catch {
      setError("Failed to add edge");
    }
  }, [setEdges]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    if (node.id.startsWith("__wave_label_")) return;
    onSelectTask?.(node.id);
  }, [onSelectTask]);

  if (!dagData) return <div className="text-zinc-500 p-4">Loading DAG...</div>;

  return (
    <div className="h-full w-full relative">
      {error && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-red-900/80 text-red-200 px-3 py-1 rounded text-xs">
          {error}
        </div>
      )}
      {/* Wave legend */}
      {waveCount > 0 && (
        <div className="absolute top-2 right-2 z-10 bg-zinc-900/90 border border-zinc-700 rounded-lg px-3 py-2 flex gap-3 text-[10px]">
          {wavePlan!.waves.map(w => (
            <div key={w.wave} className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-sm"
                style={{ background: waveColor(w.wave) }}
              />
              <span className="text-zinc-400">
                W{w.wave} <span className="text-zinc-600">({w.taskIds.length})</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        fitView
        style={{ background: "#18181b" }}
      >
        <Controls />
        <Background color="#27272a" gap={20} />
      </ReactFlow>
    </div>
  );
}
