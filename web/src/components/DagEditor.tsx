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

const STATUS_COLORS: Record<string, string> = {
  draft: "#52525b",
  queued: "#3b82f6",
  active: "#eab308",
  completed: "#22c55e",
  failed: "#ef4444",
};

export default function DagEditor({ onSelectTask }: { onSelectTask?: (id: string) => void }) {
  const [dagData, setDagData] = useState<DagData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDag = useCallback(async () => {
    try {
      const data = await api<DagData>("/api/tasks/dag");
      setDagData(data);
      setError(null);
    } catch {
      setError("Failed to load DAG");
    }
  }, []);

  useEffect(() => { loadDag(); }, [loadDag]);

  const flowNodes: Node[] = useMemo(() => {
    if (!dagData) return [];
    return dagData.nodes.map((n, i) => ({
      id: n.id,
      data: { label: `${n.id}: ${n.title.slice(0, 30)}` },
      position: { x: 50 + (i % 4) * 250, y: 50 + Math.floor(i / 4) * 120 },
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
  }, [dagData]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!dagData) return [];
    return dagData.edges.map(e => ({
      id: `${e.from_task}-${e.to_task}`,
      source: e.from_task,
      target: e.to_task,
      animated: e.edge_type === "dependency",
      style: { stroke: e.edge_type === "on_failure" ? "#ef4444" : "#6b7280" },
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
  }, [dagData]);

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
