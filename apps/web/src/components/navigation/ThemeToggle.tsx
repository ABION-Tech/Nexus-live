// Session 50 — PRD §14. Lives in components/navigation (not components/ui)
// because it's one specific, app-wired control (reads/writes
// ThemeContext directly) rather than a generic reusable primitive the
// way Button/Toggle-if-one-existed would be — same distinction Sidebar
// and ComingSoon already draw from the ui/ folder.
import { Tooltip } from '../ui';
import { useTheme } from '../../app/ThemeContext';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <Tooltip content={`Switch to ${next} mode`}>
      <button
        type="button"
        className="nx-theme-toggle"
        aria-label={`Switch to ${next} mode`}
        aria-pressed={theme === 'light'}
        onClick={() => setTheme(next)}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
    </Tooltip>
  );
}
