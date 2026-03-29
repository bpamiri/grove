export default function SeedBadge({ size = "sm" }: { size?: "sm" | "md" }) {
  const cls = size === "sm" ? "text-[10px] px-1 py-0.5" : "text-xs px-1.5 py-0.5";
  return (
    <span className={`${cls} bg-emerald-500/15 text-emerald-400 rounded font-medium`} title="This task has a seed">
      🌱
    </span>
  );
}
