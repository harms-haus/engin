import './App.css';
import { AgentLog } from './components/AgentLog';
import { EventLog } from './components/EventLog';
import { PhaseBar } from './components/PhaseBar';
import { RunsFrame } from './components/RunsFrame';
import { TaskList } from './components/TaskList';
import { useWebSocket } from './hooks/useWebSocket';
import { useError, useFailedPhase, useStatus } from './store/workflow-store';

export function App() {
  const { connected, hasConnectedOnce } = useWebSocket();
  const status = useStatus();
  const error = useError();
  const failedPhase = useFailedPhase();

  const connectionLabel = connected
    ? 'Connected'
    : hasConnectedOnce
      ? 'Disconnected — Reconnecting...'
      : 'Connecting...';

  return (
    <div className="app">
      <div
        className={`connection-status connection-status--${connected ? 'connected' : 'disconnected'}`}
        role="status"
        aria-live="polite"
      >
        {connectionLabel}
      </div>

      {status === 'failed' && (
        <div className="status-banner status-banner--failed" role="status" aria-live="polite">
          Workflow failed in phase {failedPhase ?? 'unknown'}
          {error ? `: ${error}` : ''}
        </div>
      )}
      {status === 'complete' && (
        <div className="status-banner status-banner--complete" role="status" aria-live="polite">
          ✓ Workflow complete
        </div>
      )}

      <RunsFrame />

      <main>
        <EventLog />
        <nav aria-label="Workflow phases">
          <PhaseBar />
        </nav>
        <TaskList />
        <AgentLog />
      </main>
    </div>
  );
}
