import { useWebSocket } from './hooks/useWebSocket';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { getRenderer } from './renderers/registry';
import type { WorkflowRunState } from './types';
import './App.css';

export function App() {
  const { state, selectRun, connected } = useWebSocket();

  const selectedWorkflow = state.workflows.find(
    (w) => w.id === state.selectedRunId,
  );

  if (!selectedWorkflow) {
    return (
      <div className="app">
        <Header connected={connected} />
        <div className="app-body">
          <Sidebar
            workflows={state.workflows}
            selectedRunId={state.selectedRunId}
            onSelectRun={selectRun}
          />
          <main className="app-main">
            <div className="app-main-placeholder">
              Select a workflow from the sidebar
            </div>
          </main>
        </div>
      </div>
    );
  }

  const Renderer = getRenderer(selectedWorkflow.workflowName);

  const runState: WorkflowRunState | undefined =
    state.runStates.get(selectedWorkflow.id) ?? {
      summary: selectedWorkflow,
      agents: new Map(),
      currentPhase: '',
      completedPhases: [],
    };

  return (
    <div className="app">
      <Header connected={connected} />
      <div className="app-body">
        <Sidebar
          workflows={state.workflows}
          selectedRunId={state.selectedRunId}
          onSelectRun={selectRun}
        />
        <main className="app-main">
          {Renderer && runState ? (
            <Renderer runState={runState} />
          ) : (
            <div className="app-main-placeholder">
              Workflow selected, but no renderer available
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
