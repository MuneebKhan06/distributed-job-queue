import type { ReactNode } from "react";

interface StatTileProps {
  label: string;
  value: string;
  detail?: ReactNode;
}

export default function StatTile({ label, value, detail }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {detail && <div className="stat-detail muted">{detail}</div>}
    </div>
  );
}
