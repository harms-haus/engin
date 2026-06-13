import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PastRunEntry } from '../core/config.js';
import { getDefaultWorkDir, getGlobalConfigDir, resolveProfilesDirs } from '../core/config.js';
import { initDefaultConfig } from '../core/setup.js';
import type { WorktreeInfo } from '../core/types.js';
import { composeStatusCallbacks, validateWorkflowName } from '../core/utils.js';
import { loadWorkflow } from '../core/workflow-loader.js';
import { setupWorktree } from '../core/worktree-lifecycle.js';
import type { WorkflowTUI } from '../tui/workflow-tui.js';
import type { ObserverServer } from '../web/observer-server.js';
import type { StatusBridge } from '../web/status-bridge.js';
import { createStatusCallbacks, formatTime, shouldUseTui } from './console-status.js';
import type { CliOptions } from './parse-args.js';
import { promptPostWorktreeAction } from './post-worktree.js';
import { interactiveSelectRun, resolveSessionName } from './session-selector.js';
import { setupSigintHandler } from './sigint.js';
import { setupTuiAndObserver } from './tui-setup.js';

// ─── Init Command ───────────────────────────────────────────────────────────

export async function initCommand(_options: CliOptions): Promise<void> {
  await initDefaultConfig();
  const globalDir = getGlobalConfigDir();
  console.log('Initialized engin directory structure at ' + globalDir);
}

// ─── Run Command ────────────────────────────────────────────────────────────

export async function runCommand(options: CliOptions): Promise<void> {
  if (!options.workflowName) throw new Error('workflow name is required for run command');
  if (!options.taskPrompt) throw new Error('task prompt is required for run command');
  const workflowName = options.workflowName;

  // Validate workflow name before using it in path construction
  validateWorkflowName(workflowName);

  const workDir = options.workDir ?? getDefaultWorkDir(options.cwd, workflowName);
  const workflow = await loadWorkflow(workflowName, options.cwd);
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Worktree setup
  let worktreeInfo: WorktreeInfo | undefined;
  let effectiveCwd = options.cwd;
  if (options.worktree) {
    const profilesDirs = resolveProfilesDirs(options.cwd, workflowName);
    const setup = await setupWorktree(
      options.cwd,
      profilesDirs,
      options.taskPrompt,
      Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
    );
    worktreeInfo = setup.worktreeInfo;
    effectiveCwd = setup.worktreePath;
    console.log('Worktree created at ' + setup.worktreePath + ' on branch ' + setup.branchName);
  }

  // Set up SIGINT handler for cooperative cancellation
  const { handler, cleanup, controller } = setupSigintHandler(useTui);

  let tuiInstance: WorkflowTUI | undefined;
  let observerServer: ObserverServer | undefined;
  let statusBridge: StatusBridge | undefined;

  if (useTui) {
    // Shared TUI + observer server setup
    const tuiResult = await setupTuiAndObserver({
      port: options.port,
      host: options.host,
      onTerminate: () => controller.abort(),
    });
    tuiInstance = tuiResult.tuiInstance;
    observerServer = tuiResult.observerServer;
    statusBridge = tuiResult.statusBridge;
  }

  process.on('SIGINT', handler);
  try {
    if (useTui && tuiInstance && statusBridge) {
      const tuiCallbacks = tuiInstance.getStatusCallbacks();
      const bridgeCallbacks = statusBridge.getCallbacks();
      const composedCallbacks = composeStatusCallbacks([tuiCallbacks, bridgeCallbacks]);

      await workflow.run(options.taskPrompt as string, {
        cwd: effectiveCwd,
        workDir,
        maxConcurrentTasks: options.maxConcurrent,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
        verbose: false,
        onStatus: composedCallbacks,
        signal: controller.signal,
        ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
      });
    } else {
      await workflow.run(options.taskPrompt as string, {
        cwd: effectiveCwd,
        workDir,
        maxConcurrentTasks: options.maxConcurrent,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
        verbose: options.verbose,
        onStatus: createStatusCallbacks(options.verbose),
        signal: controller.signal,
        ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
      });
    }

    if (tuiInstance) {
      // Keep TUI alive for inspection, passing signal so web terminate resolves the pause
      await tuiInstance.pauseForInspection(controller.signal);
      tuiInstance.stop();
      observerServer?.stop();
      tuiInstance = undefined;
      observerServer = undefined;
    }

    if (worktreeInfo) {
      const profilesDirs = resolveProfilesDirs(worktreeInfo.originalCwd, workflowName);
      await promptPostWorktreeAction({
        profilesDirs,
        repoRoot: worktreeInfo.originalCwd,
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        originalCwd: worktreeInfo.originalCwd,
        taskPrompt: options.taskPrompt,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
      });
    }
  } finally {
    tuiInstance?.stop();
    observerServer?.stop();
    cleanup();
  }
}

// ─── Resume Command ─────────────────────────────────────────────────────────

export async function resumeCommand(options: CliOptions): Promise<void> {
  let run: PastRunEntry;

  if (options.sessionName) {
    run = await resolveSessionName(options.sessionName, options.cwd);
  } else {
    const selected = await interactiveSelectRun(options.cwd);
    if (!selected) {
      process.exit(0);
    }
    run = selected;
  }

  if (!run.hasStateFile) {
    throw new Error(
      `Run "${run.dirName}" does not have a resumable state file. It may have been manually cleaned up or interrupted before saving state.`,
    );
  }

  // Read the state file to get the task prompt
  const statePath = join(run.fullPath, '.engin-state.json');
  const stateRaw = readFileSync(statePath, 'utf-8');
  const state = JSON.parse(stateRaw) as {
    taskPrompt: string;
    currentPhase?: string;
    completedPhases?: string[];
    tasks?: {
      id: string;
      title: string;
      status: string;
      assignedAgent?: string;
      phase?: string;
    }[];
    sidebar?: { title?: string; indicator?: string; phases?: { id: string; label: string; icon: string }[] };
    worktree?: { worktreePath: string; branchName: string; originalCwd: string };
    spawnedAgents?: {
      agentId: string;
      profile: string;
      phase: string;
      taskId?: string;
      completedAt?: string;
    }[];
  };
  const taskPrompt = state.taskPrompt;
  const worktreeInfo = state.worktree;

  if (!taskPrompt) {
    throw new Error(`Run "${run.dirName}" has no task prompt in its state file. Cannot resume.`);
  }

  const workDir = run.fullPath;
  const workflowName = run.workflowName;

  if (worktreeInfo) {
    options = { ...options, cwd: worktreeInfo.worktreePath };
    console.log(`${formatTime()} Resuming in worktree: ${worktreeInfo.branchName}`);
  }

  console.log(`${formatTime()} 🔄 Resuming run: ${run.dirName}`);
  console.log(`${formatTime()}    Workflow: ${workflowName}`);
  console.log(`${formatTime()}    Prompt:   ${taskPrompt}`);
  console.log();

  validateWorkflowName(workflowName);
  const workflow = await loadWorkflow(workflowName, options.cwd);
  const useTui = shouldUseTui({ verbose: options.verbose, isTty: !!process.stdout.isTTY });

  // Set up SIGINT handler for cooperative cancellation
  const { handler, cleanup, controller } = setupSigintHandler(useTui);

  let tuiInstance: WorkflowTUI | undefined;
  let observerServer: ObserverServer | undefined;
  let statusBridge: StatusBridge | undefined;

  if (useTui) {
    // Shared TUI + observer server setup (with agents from previous run)
    const tuiResult = await setupTuiAndObserver({
      port: options.port,
      host: options.host,
      onTerminate: () => controller.abort(),
      initialAgents: state.spawnedAgents,
    });
    tuiInstance = tuiResult.tuiInstance;
    observerServer = tuiResult.observerServer;
    statusBridge = tuiResult.statusBridge;

    // Resume-specific: seed the bridge with persisted state so late-connecting
    // clients receive the full picture (phases, tasks, sidebar, etc.).
    statusBridge.seed({
      currentPhase: state.currentPhase,
      completedPhases: state.completedPhases,
      tasks: state.tasks?.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        agentId: t.assignedAgent,
        phase: t.phase,
      })),
      sidebar: state.sidebar
        ? {
            title: state.sidebar.title ?? '',
            indicator: state.sidebar.indicator ?? '',
            ...(state.sidebar.phases ? { phases: state.sidebar.phases } : {}),
          }
        : undefined,
      taskPrompt: state.taskPrompt,
    });
  }

  process.on('SIGINT', handler);
  try {
    if (useTui && tuiInstance && statusBridge) {
      const tuiCallbacks = tuiInstance.getStatusCallbacks();
      const bridgeCallbacks = statusBridge.getCallbacks();
      const composedCallbacks = composeStatusCallbacks([tuiCallbacks, bridgeCallbacks]);

      await workflow.run(taskPrompt, {
        cwd: options.cwd,
        workDir,
        maxConcurrentTasks: options.maxConcurrent,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
        verbose: false,
        onStatus: composedCallbacks,
        signal: controller.signal,
        ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
      });
    } else {
      await workflow.run(taskPrompt, {
        cwd: options.cwd,
        workDir,
        maxConcurrentTasks: options.maxConcurrent,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
        verbose: options.verbose,
        onStatus: createStatusCallbacks(options.verbose),
        signal: controller.signal,
        ...(worktreeInfo ? { worktree: worktreeInfo } : {}),
      });
    }

    if (tuiInstance) {
      // Keep TUI alive for inspection, passing signal so web terminate resolves the pause
      await tuiInstance.pauseForInspection(controller.signal);
      tuiInstance.stop();
      observerServer?.stop();
      tuiInstance = undefined;
      observerServer = undefined;
    }

    if (worktreeInfo) {
      const profilesDirs = resolveProfilesDirs(worktreeInfo.originalCwd, workflowName);
      await promptPostWorktreeAction({
        profilesDirs,
        repoRoot: worktreeInfo.originalCwd,
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        originalCwd: worktreeInfo.originalCwd,
        taskPrompt,
        apiKeys: Object.keys(options.apiKeys).length > 0 ? options.apiKeys : undefined,
      });
    }
  } finally {
    tuiInstance?.stop();
    observerServer?.stop();
    cleanup();
  }
}
