import { useCallback } from "react";
import { useWebSocket, type WsMessage } from "./hooks/useWebSocket";
import { useTasks } from "./hooks/useTasks";
import { useChat } from "./hooks/useChat";
import { usePaneSizes } from "./hooks/usePaneSizes";
import { useLocalStorage } from "./hooks/useLocalStorage";
import Sidebar from "./components/Sidebar";
import TaskList from "./components/TaskList";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import ResizeHandle from "./components/ResizeHandle";

type View = "tasks" | "settings";

export default function App() {
  const [view, setView] = useLocalStorage<View>("grove-ui-view", "tasks");
  const taskState = useTasks();
  const { connected, send } = useWebSocket({
    onMessage: useCallback((msg: WsMessage) => {
      taskState.handleWsMessage(msg);
      chatState.handleWsMessage(msg);
    }, []),
  });
  const chatState = useChat(send);
  const { sizes, onMouseDown } = usePaneSizes();

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
        width={sizes.sidebar}
      />

      <ResizeHandle onMouseDown={(e) => onMouseDown("sidebar", e)} />

      {/* Center */}
      <main className="flex-1 overflow-y-auto border-zinc-800 min-w-0">
        {view === "tasks" ? (
          <TaskList
            tasks={taskState.tasks}
            getActivity={taskState.getActivity}
            onRefresh={taskState.refresh}
            send={send}
          />
        ) : (
          <Settings
            trees={taskState.trees}
            status={taskState.status}
            onRefresh={taskState.refresh}
          />
        )}
      </main>

      <ResizeHandle onMouseDown={(e) => onMouseDown("chat", e)} />

      {/* Right: Chat */}
      <aside style={{ width: sizes.chat }} className="flex flex-col border-zinc-800 flex-shrink-0">
        <Chat
          messages={chatState.messages}
          onSend={chatState.sendMessage}
          bottomRef={chatState.bottomRef}
          connected={connected}
          thinking={chatState.thinking}
        />
      </aside>
    </div>
  );
}
