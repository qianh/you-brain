export function Skeleton({
  width = "100%",
  height = 12,
  className = "",
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return <span className={["skeleton", className].filter(Boolean).join(" ")} style={{ width, height, display: "block" }} />;
}

export function SkeletonRow() {
  return (
    <div className="skeleton-row" aria-hidden="true">
      <Skeleton width={32} height={32} />
      <span>
        <Skeleton width="62%" height={12} />
        <Skeleton width="40%" height={10} />
      </span>
      <Skeleton width={64} height={12} />
    </div>
  );
}

export function SkeletonStat() {
  return (
    <div className="skeleton-stat" aria-hidden="true">
      <Skeleton width={72} height={28} />
      <Skeleton width={48} height={10} />
      <Skeleton width={96} height={10} />
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </div>
  );
}
