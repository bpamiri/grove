import { useState, useCallback } from "react";
import { useWebSocket, type WsMessage } from "./hooks/useWebSocket";
import { useTasks } from "./hooks/useTasks";
import { useChat } from "./hooks/useChat";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import Chat from "./components/Chat";
import Settings from "./components/Settings";

type View = "tasks" | "settings";

export default function App() {
  const [view, setView] = useState<View>("tasks");
  const taskState = useTasks();
  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: WsMessage) => {
      taskState.handleWsMessage(msg);
      chatState.handleWsMessage(msg);
    }, []),
  });
  const chatState = useChat(send);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left Sidebar */}
      <Sidebar
        trees={taskState.trees}
        status={taskState.status}
        selectedTree={taskState.selectedTree}
        onSelectTree={(id) => {
          taskState.setSelectedTree(id);
          setView("tasks");
        }}
        connected={connected}
        view={view}
        onViewChange={setView}
      />

      {/* Center */}
      <main className="flex-1 overflow-y-auto border-x border-zinc-800">
        {view === "tasks" ? (
          <TaskList
            tasks={taskState.tasks}
            getActivity={taskState.getActivity}
            onRefresh={taskState.refresh}
          />
        ) : (
          <Settings
            trees={taskState.trees}
            status={taskState.status}
            onRefresh={taskState.refresh}
          />
        )}
      </main>

      {/* Right: Chat */}
      <aside className="w-80 flex flex-col border-zinc-800">
        <Chat
          messages={chatState.messages}
          onSend={chatState.sendMessage}
          bottomRef={chatState.bottomRef}
          connected={connected}
        />
      </aside>
    </div>
  );
}
