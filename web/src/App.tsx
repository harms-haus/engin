import { useCallback } from 'react';
import './App.css';
import { AgentLog } from './components/AgentLog';
import { EventLog } from './components/EventLog';
import { LanePool } from './components/LanePool';
import { PhaseBar } from './components/PhaseBar';
import { useWebSocket } from './hooks/useWebSocket';

export function App() {
  const { state, send, events } = useWebSocket();

  const handleTerminate = useCallback(() => {
    send({ type: 'terminate_server' });
  }, [send]);

  const phases = state.sidebar.phases ?? [];

  return (
    <div className="app">
      <EventLog entries={events} />
      <PhaseBar phases={phases} currentPhase={state.currentPhase} completedPhases={state.completedPhases} />
      <LanePool tasks={state.tasks} />
      <AgentLog agents={state.agents} onTerminate={handleTerminate} status={state.status} />
    </div>
  );
}
