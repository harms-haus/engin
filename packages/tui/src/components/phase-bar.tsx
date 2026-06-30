import type { PhaseEntity } from '@engin/shared';
import { Box, Text } from 'ink';
import React from 'react';

// ─── Props ───────────────────────────────────────────────────────────────────

export interface PhaseBarProps {
  phases: PhaseEntity[];
  currentPhaseId: string;
  completedPhaseIds: string[];
  selectedPhaseId: string;
  indicator?: string;
}

// ─── PhaseBar Component ─────────────────────────────────────────────────────

export const PhaseBar: React.FC<PhaseBarProps> = ({
  phases,
  currentPhaseId,
  completedPhaseIds,
  selectedPhaseId,
  indicator,
}) => {
  if (phases.length === 0) {
    const line = [indicator, currentPhaseId].filter(Boolean).join(' ');
    return (
      <Box flexDirection="row">
        <Text wrap="truncate-end">{line}</Text>
      </Box>
    );
  }

  const effectiveSelected = selectedPhaseId || currentPhaseId;

  return (
    <Box flexDirection="row">
      {indicator && <Text>{indicator} </Text>}
      <Text wrap="truncate-end">
        {phases.map((phase, i) => {
          const completed = completedPhaseIds.includes(phase.id);
          const running = phase.id === currentPhaseId;
          const selected = phase.id === effectiveSelected;

          return (
            <React.Fragment key={phase.id}>
              {i > 0 && <Text dimColor> │ </Text>}
              {completed ? (
                <Text color="green">✓</Text>
              ) : running ? (
                <Text color="cyan" bold>
                  ●
                </Text>
              ) : (
                <Text dimColor>·</Text>
              )}
              <Text> </Text>
              {selected ? (
                <Text underline>{phase.label}</Text>
              ) : running ? (
                <Text bold>{phase.label}</Text>
              ) : !completed ? (
                <Text dimColor>{phase.label}</Text>
              ) : (
                <Text>{phase.label}</Text>
              )}
            </React.Fragment>
          );
        })}
      </Text>
    </Box>
  );
};
