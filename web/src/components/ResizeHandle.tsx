interface Props {
  onMouseDown: (e: React.MouseEvent) => void;
}

export default function ResizeHandle({ onMouseDown }: Props) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-zinc-800 hover:bg-emerald-500/40 transition-colors flex-shrink-0"
    />
  );
}
