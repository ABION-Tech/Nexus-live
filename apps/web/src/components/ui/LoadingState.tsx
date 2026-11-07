export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="nx-state">
      <span className="nx-spinner" />
      <span>{label}</span>
    </div>
  );
}
