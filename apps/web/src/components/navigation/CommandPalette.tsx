// Session 61 — the command palette. ⌘K (Ctrl K on Windows/Android) or "/"
// opens it anywhere; type to jump to any page you can reach, start a new
// task or goal, switch company or change the theme. Arrow keys move,
// Enter goes, Esc closes. Built from the same nav model as the sidebar, so
// it only ever offers what this person may open.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, CornerDownLeft, Moon, Plus, Search, Sun } from 'lucide-react';
import type { CurrentUser } from '../../services/authService';
import { useTheme } from '../../app/ThemeContext';
import { navIcon } from './sectionIcons';
import { useNavModel } from './navModel';
import { useWorkspaces } from './WorkspaceContext';
import { OPEN_PALETTE_EVENT } from './quickAdd';
import { score } from './paletteScore';


interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  run: () => void;
  keywords?: string;
}

export function CommandPalette({ user }: { user: CurrentUser }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();
  const { groups } = useNavModel(user);
  const { theme, setTheme } = useTheme();
  const { workspaces, switchTo } = useWorkspaces();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !typing && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      setOpen(false);
      navigate(path);
    };
    const out: Command[] = [];
    const isLeader = user.role === 'leader';
    out.push({ id: 'new-task', label: 'New task', group: 'Actions', icon: <Plus size={16} />, run: go('/work/my-tasks?new=1'), keywords: 'add create task' });
    if (isLeader) out.push({ id: 'new-goal', label: 'New goal', group: 'Actions', icon: <Plus size={16} />, run: go('/goals?new=1'), keywords: 'add create goal' });
    out.push({
      id: 'theme',
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      group: 'Actions',
      icon: theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />,
      run: () => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
        setOpen(false);
      },
      keywords: 'theme dark light mode appearance',
    });
    for (const g of groups) {
      for (const i of g.items) {
        const Icon = navIcon(i.icon);
        out.push({ id: i.path, label: i.label, hint: g.label, group: 'Go to', icon: <Icon size={16} />, run: go(i.path) });
        for (const c of i.children) out.push({ id: c.path, label: c.label, hint: i.label, group: 'Go to', icon: <ArrowRight size={16} />, run: go(c.path), keywords: i.label });
      }
    }
    for (const w of workspaces.filter((x) => !x.isCurrent)) {
      out.push({
        id: `ws-${w.orgId}`,
        label: `Switch to ${w.name}`,
        group: 'Companies',
        icon: <Building2 size={16} />,
        run: () => {
          setOpen(false);
          void switchTo(w.orgId);
        },
        keywords: 'company workspace switch',
      });
    }
    return out;
  }, [groups, navigate, theme, setTheme, user.role, workspaces, switchTo]);

  const results = useMemo(() => {
    if (!q.trim()) return commands.filter((c) => c.group !== 'Go to' || !c.hint || groups.some((g) => g.label === c.hint)).slice(0, 40);
    return commands
      .map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.keywords ?? '') * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.c);
  }, [q, commands, groups]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[sel]?.run();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  let lastGroup = '';
  return createPortal(
    <div className="nx-palette" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="nx-palette__box nx-pop" role="dialog" aria-label="Search and jump" aria-modal="true">
        <div className="nx-palette__field">
          <Search size={17} strokeWidth={2} aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, actions and companies…"
            aria-label="Search pages, actions and companies"
            role="combobox"
            aria-expanded="true"
            aria-controls="nx-palette-list"
            aria-activedescendant={results[sel] ? `nx-pal-${sel}` : undefined}
          />
          <kbd className="nx-kbd">Esc</kbd>
        </div>
        <ul className="nx-palette__list" id="nx-palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="nx-palette__empty">Nothing matches "{q}".</li>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {head && <div className="nx-palette__group">{head}</div>}
                <button
                  type="button"
                  id={`nx-pal-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  className={'nx-palette__item' + (i === sel ? ' is-sel' : '')}
                  onMouseMove={() => setSel(i)}
                  onClick={() => c.run()}
                >
                  <span className="nx-palette__icon" aria-hidden="true">{c.icon}</span>
                  <span className="nx-palette__label">{c.label}</span>
                  {c.hint && <span className="nx-palette__hint">{c.hint}</span>}
                  {i === sel && <CornerDownLeft className="nx-palette__enter" size={14} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="nx-palette__foot">
          <span><kbd className="nx-kbd">↑</kbd><kbd className="nx-kbd">↓</kbd> move</span>
          <span><kbd className="nx-kbd">↵</kbd> open</span>
          <span><kbd className="nx-kbd">/</kbd> or <kbd className="nx-kbd">⌘K</kbd> anywhere</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
