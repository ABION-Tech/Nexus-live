export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  /**
   * Pulsing dot instead of the plain static one — reserved for badges
   * that represent an actually-live, polled/websocket value (PRD §8.1:
   * "Badges are live... for Tasks and Calendar items"), not static
   * status markers (enabled/disabled, billing status, audit result)
   * which use plain `dot` elsewhere and shouldn't pulse indefinitely.
   */
  live?: boolean;
}

export function Badge({ children, tone = 'neutral', dot = false, live = false }: BadgeProps) {
  return (
    <span className={`nx-badge nx-badge--${tone}`}>
      {live ? <span className={`nx-pulse-dot nx-pulse-dot--${tone}`} /> : dot && <span className="nx-badge__dot" />}
      {children}
    </span>
  );
}
