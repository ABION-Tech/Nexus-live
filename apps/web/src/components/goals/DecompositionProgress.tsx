import { useEffect, useState } from 'react';

// PRD §8.5: "The current animated 'thinking' indicator
// (startGoalProgressStages/stopGoalProgressStages) during decomposition
// is confirmed as real — preserve as a loading state component, not a
// spinner." This is that component: cycles through named stages rather
// than showing an indeterminate spinner, since AI decomposition (a few
// seconds, sometimes longer against a real model) reads as "stuck"
// without one. Stage list is illustrative, not literal telemetry — there's
// no per-stage callback from AIService, so this fakes the appearance of
// progress the same way the MVP's own JS-interval version did.
const STAGES = [
  'Reading the goal…',
  'Breaking it into concrete steps…',
  'Working out what depends on what…',
  'Finalizing the task list…',
];

export function DecompositionProgress() {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, STAGES.length - 1));
    }, 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="nx-state">
      <span className="nx-spinner" />
      <span>{STAGES[stageIndex]}</span>
    </div>
  );
}
