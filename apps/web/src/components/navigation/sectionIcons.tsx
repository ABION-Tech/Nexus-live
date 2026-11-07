import {
  LayoutDashboard,
  CheckSquare,
  Network,
  Users,
  Target,
  BookOpen,
  BarChart3,
  Bot,
  MessagesSquare,
  Zap,
  Settings,
  Building2,
  Building,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

// UI Rehaul polish pass — sidebar previously showed a PRD §7.2 numeral
// ("01", "02"...) as the only per-section visual anchor, which reads as
// an internal spec document rather than a finished product nav. One
// icon per top-level section id, keyed here rather than inlined in
// Sidebar.tsx so ia.ts (the data) stays icon-agnostic and this can be
// swapped independently of the IA tree itself.
//
// Reviewed once after first pass: Share2 (a "share this" action icon)
// was standing in for the Network section, and Sparkles (generic
// "AI magic" decoration) for AI Analyst — neither actually represents
// what those sections do. Network is a literal node-topology icon
// (relationship tracking); Bot reflects that AI Analyst is an agent
// doing analyst work (Reports/Chat/Agent Handoff), not a sparkle effect.
export const SECTION_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  work: CheckSquare,
  network: Network,
  people: Users,
  goals: Target,
  knowledge: BookOpen,
  analytics: BarChart3,
  'ai-analyst': Bot,
  'comms-ops': MessagesSquare,
  automation: Zap,
  settings: Settings,
  'admin-group': Building2,
  'admin-company': Building,
  'admin-platform': ShieldCheck,
};

export function sectionIcon(id: string): LucideIcon {
  return SECTION_ICONS[id] ?? LayoutDashboard;
}
