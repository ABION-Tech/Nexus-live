// Session 61 — the sidebar, ⌘K palette and phone tab bar share one model of
// what a person can reach; these pin it down.
import { describe, expect, it } from 'vitest';
import { activePathFor, visibleNav } from './navModel';
import { score } from './paletteScore';
import type { CurrentUser } from '../../services/authService';

const base = { id: 'u', orgId: 'o', name: 'Ada', email: 'ada@x.test', isPlatformAdmin: false, isGroupAdmin: false, isCompanyAdmin: false } as CurrentUser;
const member = { ...base, role: 'team_member' } as CurrentUser;
const superAdmin = { ...base, role: 'leader', isPlatformAdmin: true, isCompanyAdmin: true } as CurrentUser;
const paths = (u: CurrentUser) => visibleNav(u).flatMap((g) => g.items.map((i) => i.path));

describe('visibleNav', () => {
  it('admin pages only for admins', () => {
    expect(paths(member)).not.toContain('/admin/platform');
    expect(paths(superAdmin)).toContain('/admin/platform');
  });

  it('never lists a page twice (Group and Company Admin share /admin)', () => {
    const p = paths({ ...superAdmin, isGroupAdmin: true } as CurrentUser);
    expect(new Set(p).size).toBe(p.length);
  });

  it('drops empty groups', () => {
    for (const g of visibleNav(member)) expect(g.items.length).toBeGreaterThan(0);
  });
});

describe('activePathFor', () => {
  const groups = visibleNav(superAdmin);
  it('a sub-page lights its parent item', () => {
    const people = groups.flatMap((g) => g.items).find((i) => i.path === '/people');
    const child = people?.children[0]?.path;
    expect(child).toBeTruthy();
    expect(activePathFor(child!, groups)).toBe('/people');
  });
  it('the most specific item wins (Review Queue, not Goals)', () => {
    expect(activePathFor('/goals/review-queue', groups)).toBe('/goals/review-queue');
  });
  it('a drill-in page lights the list it came from', () => {
    expect(activePathFor('/work/projects/123', groups)).toBe('/work/projects');
  });
});

describe('palette score', () => {
  it('prefix beats word start beats inside a word beats scattered letters', () => {
    expect(score('fol', 'Follow-Ups')).toBeGreaterThan(score('fol', 'Open follow-ups'));
    expect(score('ups', 'Follow ups')).toBeGreaterThan(score('ups', 'Followups'));
    expect(score('mytk', 'My Tasks')).toBeGreaterThan(0);
  });
  it('no match is zero', () => {
    expect(score('zzz', 'My Tasks')).toBe(0);
  });
});
