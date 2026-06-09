import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseArgs,
  formatTime,
  createStatusCallbacks,
  main,
} from "../src/cli.ts";
import { useEnvSandbox } from "./helpers/env-sandbox.js";

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses run command with workflowName and taskPrompt", () => {
    const result = parseArgs(["develop", "build a feature", "--cwd", "/c"]);
    expect(result).toEqual({
      command: "run",
      workflowName: "develop",
      taskPrompt: "build a feature",
      cwd: "/c",
      workDir: undefined,
      maxConcurrent: 3,
      verbose: false,
      apiKeys: {},
      force: undefined,
    });
  });

  it("parses run with all options", () => {
    const result = parseArgs([
      "develop",
      "build a feature",
      "--cwd",
      "/c",
      "--work-dir",
      "/w",
      "--max-concurrent",
      "5",
      "--verbose",
      "--api-key",
      "anthropic=sk-xxx",
      "--api-key",
      "openai=pk-yyy",
    ]);
    expect(result.command).toBe("run");
    expect(result.workflowName).toBe("develop");
    expect(result.taskPrompt).toBe("build a feature");
    expect(result.cwd).toBe("/c");
    expect(result.workDir).toBe("/w");
    expect(result.maxConcurrent).toBe(5);
    expect(result.verbose).toBe(true);
    expect(result.apiKeys).toEqual({
      anthropic: "sk-xxx",
      openai: "pk-yyy",
    });
  });

  it("parses list command", () => {
    const result = parseArgs(["list"]);
    expect(result.command).toBe("list");
    expect(result.workflowName).toBeUndefined();
    expect(result.taskPrompt).toBeUndefined();
  });

  it("parses list with --cwd", () => {
    const result = parseArgs(["list", "--cwd", "/my/project"]);
    expect(result).toEqual({
      command: "list",
      cwd: "/my/project",
      workflowName: undefined,
      taskPrompt: undefined,
      workDir: undefined,
      maxConcurrent: 3,
      verbose: false,
      apiKeys: {},
      force: undefined,
    });
  });

  it("parses init command", () => {
    const result = parseArgs(["init"]);
    expect(result.command).toBe("init");
    expect(result.force).toBeFalsy();
  });

  it("parses init with --force", () => {
    const result = parseArgs(["init", "--force"]);
    expect(result.command).toBe("init");
    expect(result.force).toBe(true);
  });

  it("throws on missing command", () => {
    expect(() => parseArgs([])).toThrow(/Missing command/);
  });

  it("throws on missing task prompt for run", () => {
    expect(() => parseArgs(["develop"])).toThrow(
      /Missing required <task-prompt>/,
    );
  });

  it("throws on unknown flag", () => {
    expect(() => parseArgs(["develop", "task", "--bogus"])).toThrow(
      /Unknown flag/,
    );
  });

  it("throws on list with extra positional", () => {
    expect(() => parseArgs(["list", "extra"])).toThrow(/Unexpected argument/);
  });

  it("throws on init with extra positional", () => {
    expect(() => parseArgs(["init", "extra"])).toThrow(/Unexpected argument/);
  });

  it("throws on invalid --api-key format", () => {
    expect(() =>
      parseArgs(["develop", "task", "--api-key", "noequals"]),
    ).toThrow(/Invalid --api-key format/);
  });

  it("--cwd defaults to process.cwd()", () => {
    const result = parseArgs(["list"]);
    expect(result.cwd).toBe(process.cwd());
  });

  it("--max-concurrent defaults to 3", () => {
    const result = parseArgs(["develop", "task"]);
    expect(result.maxConcurrent).toBe(3);
  });

  it("--verbose defaults to false", () => {
    const result = parseArgs(["list"]);
    expect(result.verbose).toBe(false);
  });

  it("parses --api-key repeatable", () => {
    const result = parseArgs([
      "develop",
      "task",
      "--api-key",
      "anthropic=sk-xxx",
      "--api-key",
      "openai=pk-yyy",
    ]);
    expect(result.apiKeys).toEqual({
      anthropic: "sk-xxx",
      openai: "pk-yyy",
    });
  });

  describe("--max-concurrent validation", () => {
    it("accepts valid positive integer", () => {
      const result = parseArgs(["develop", "task", "--max-concurrent", "5"]);
      expect(result.maxConcurrent).toBe(5);
    });

    it("rejects zero", () => {
      expect(() =>
        parseArgs(["develop", "task", "--max-concurrent", "0"]),
      ).toThrow(/positive integer/);
    });

    it("rejects negative number", () => {
      expect(() =>
        parseArgs(["develop", "task", "--max-concurrent", "-1"]),
      ).toThrow(/positive integer/);
    });

    it("rejects float", () => {
      expect(() =>
        parseArgs(["develop", "task", "--max-concurrent", "1.5"]),
      ).toThrow(/positive integer/);
    });

    it("rejects non-numeric string", () => {
      expect(() =>
        parseArgs(["develop", "task", "--max-concurrent", "abc"]),
      ).toThrow(/positive integer/);
    });

    it("rejects empty string", () => {
      expect(() =>
        parseArgs(["develop", "task", "--max-concurrent", ""]),
      ).toThrow(/positive integer/);
    });
  });

  describe("--help and --version", () => {
    it("--help returns { command: 'help' }", () => {
      const result = parseArgs(["--help"]);
      expect(result).toEqual({
        command: "help",
        cwd: process.cwd(),
        maxConcurrent: 3,
        verbose: false,
        apiKeys: {},
      });
    });

    it("-h returns { command: 'help' }", () => {
      const result = parseArgs(["-h"]);
      expect(result.command).toBe("help");
    });

    it("--version returns { command: 'version' }", () => {
      const result = parseArgs(["--version"]);
      expect(result).toEqual({
        command: "version",
        cwd: process.cwd(),
        maxConcurrent: 3,
        verbose: false,
        apiKeys: {},
      });
    });

    it("-v returns { command: 'version' }", () => {
      const result = parseArgs(["-v"]);
      expect(result.command).toBe("version");
    });

    it("--help works when mixed with other args", () => {
      const result = parseArgs(["develop", "task", "--help"]);
      expect(result.command).toBe("help");
    });
  });

  describe("main() handles help and version", () => {
    let exitSpy: ReturnType<typeof spyOn>;
    let stdoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      exitSpy = spyOn(process, "exit").mockImplementation(((
        code: number,
      ) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      stdoutSpy = spyOn(process.stdout, "write")
        .mockImplementation(() => true);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it("main() calls process.exit(0) for --help", async () => {
      const originalArgv = process.argv;
      process.argv = ["node", "cli.ts", "--help"];
      try {
        await expect(main()).rejects.toThrow("process.exit(0)");
      } finally {
        process.argv = originalArgv;
      }
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain("Usage:");
    });

    it("main() calls process.exit(0) for --version", async () => {
      const originalArgv = process.argv;
      process.argv = ["node", "cli.ts", "--version"];
      try {
        await expect(main()).rejects.toThrow("process.exit(0)");
      } finally {
        process.argv = originalArgv;
      }
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      expect(output).toContain("workflow-harness v");
    });
  });

  it("treats non-keyword first positional as workflow name (implicit run)", () => {
    const result = parseArgs(["my-workflow", "do something", "--cwd", "/c"]);
    expect(result.command).toBe("run");
    expect(result.workflowName).toBe("my-workflow");
    expect(result.taskPrompt).toBe("do something");
  });
});

// ─── formatTime ─────────────────────────────────────────────────────────────

describe("formatTime", () => {
  it("returns bracketed time format", () => {
    const result = formatTime();
    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\]$/);
  });
});

// ─── createStatusCallbacks ─────────────────────────────────────────────────

describe("createStatusCallbacks", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("non-verbose has no agent-level callbacks", () => {
    const callbacks = createStatusCallbacks(false);
    expect(callbacks.onTurnStart).toBeUndefined();
    expect(callbacks.onTurnEnd).toBeUndefined();
    expect(callbacks.onToolCallStart).toBeUndefined();
    expect(callbacks.onToolCallEnd).toBeUndefined();
  });

  it("verbose has agent-level callbacks", () => {
    const callbacks = createStatusCallbacks(true);
    expect(typeof callbacks.onTurnStart).toBe("function");
    expect(typeof callbacks.onTurnEnd).toBe("function");
    expect(typeof callbacks.onToolCallStart).toBe("function");
    expect(typeof callbacks.onToolCallEnd).toBe("function");
  });

  it("onWorkflowStart logs formatted output", () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowStart!({
      taskPrompt: "build it",
      resumed: false,
      workDir: "/tmp",
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow started/);
  });

  it("onPhaseStart logs formatted output", () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onPhaseStart!({ phase: "planning" as never, round: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Phase started/);
  });

  it("onWorkflowComplete logs duration", () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowComplete!({
      totalDurationMs: 5000,
      agentCount: 3,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow complete/);
  });

  it("onWorkflowFailed logs error", () => {
    const callbacks = createStatusCallbacks(false);
    callbacks.onWorkflowFailed!({
      error: new Error("boom"),
      phase: "execution",
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Workflow failed/);
  });

  it("onTurnStart logs in verbose mode", () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onTurnStart!({ agentId: "agent-1", turn: 2 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Turn/);
  });

  it("onToolCallStart logs tool name", () => {
    const callbacks = createStatusCallbacks(true);
    callbacks.onToolCallStart!({
      agentId: "agent-1",
      toolName: "read_file",
      toolCallId: "tc-1",
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/Tool call/);
  });
});

// ─── main() loads .env files ────────────────────────────────────────────────

describe("main() loads .env files", () => {
  useEnvSandbox();

  let exitSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let tempDir: string;

  beforeEach(() => {
    exitSpy = spyOn(process, "exit").mockImplementation(((
      code: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = spyOn(console, "log").mockImplementation(() => {});

    tempDir = mkdtempSync(join(tmpdir(), "wh-cli-test-"));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads .env from .workflow-harness/.env for list command", async () => {
    // Create .workflow-harness/.env in temp dir
    const harnessDir = join(tempDir, ".workflow-harness");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(
      join(harnessDir, ".env"),
      "TEST_CLI_ENV_VAR=from_cli_test\n",
    );

    const originalArgv = process.argv;
    process.argv = ["node", "cli.ts", "list", "--cwd", tempDir];
    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }

    expect(process.env.TEST_CLI_ENV_VAR).toBe("from_cli_test");
  });

  it("does not load .env files for help command", async () => {
    const harnessDir = join(tempDir, ".workflow-harness");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(
      join(harnessDir, ".env"),
      "TEST_CLI_ENV_VAR_HELP=should_not_appear\n",
    );

    const originalArgv = process.argv;
    process.argv = ["node", "cli.ts", "--help", "--cwd", tempDir];
    try {
      await expect(main()).rejects.toThrow("process.exit(0)");
    } finally {
      process.argv = originalArgv;
    }

    expect(process.env.TEST_CLI_ENV_VAR_HELP).toBeUndefined();
  });

  it("does not load .env files for version command", async () => {
    const harnessDir = join(tempDir, ".workflow-harness");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(
      join(harnessDir, ".env"),
      "TEST_CLI_ENV_VAR_VERSION=should_not_appear\n",
    );

    const originalArgv = process.argv;
    process.argv = ["node", "cli.ts", "--version", "--cwd", tempDir];
    try {
      await expect(main()).rejects.toThrow("process.exit(0)");
    } finally {
      process.argv = originalArgv;
    }

    expect(process.env.TEST_CLI_ENV_VAR_VERSION).toBeUndefined();
  });
});
