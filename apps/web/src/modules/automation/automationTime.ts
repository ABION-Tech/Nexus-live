// Session 60 (C-04): time labels shared by the company Automation panel
// and the Super Admin "Scheduled jobs" card.

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** "today 16:00", "tomorrow 08:00", "Mon 08:00" — in the viewer's own time. */
export function nextRunLabel(iso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(new Date())) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
