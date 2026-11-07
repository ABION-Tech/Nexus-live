import { EmptyState } from '../ui/EmptyState';

export interface ComingSoonProps {
  sectionLabel: string;
  subsectionLabel: string;
}

// Rendered for every IA subsection (app/ia.ts) not yet built — keeps the
// full §7.2 nav tree navigable end to end even where the module behind
// it doesn't exist. Not an error state: this is the honest, current
// state of the build, same as SESSION_LOG's own next-steps lists.
export function ComingSoon({ sectionLabel, subsectionLabel }: ComingSoonProps) {
  return (
    <EmptyState
      title={`${subsectionLabel} isn't built yet`}
      description={`${sectionLabel} → ${subsectionLabel} is on the roadmap (see SESSION_LOG.md's next-steps) but has no module behind it yet.`}
    />
  );
}
