export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-rows">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton skeleton-avatar" />
          <span className="skeleton skeleton-line" />
        </div>
      ))}
    </div>
  );
}
