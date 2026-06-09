import type { Task, TaskStatus } from "../core/types.js";

export class TaskTracker {
    private tasks: Map<string, Task>;

    constructor() {
        this.tasks = new Map();
    }

    addTask(task: Omit<Task, "status"> & { status?: TaskStatus }): void {
        if (this.tasks.has(task.id)) {
            throw new Error(`Task with id "${task.id}" already exists`);
        }

        const deps = task.dependencies ?? [];

        // Insert temporarily, then check for cycles. Roll back on failure.
        const status: TaskStatus =
            task.status ?? (deps.every((dep) => {
                const depTask = this.tasks.get(dep);
                return depTask !== undefined && depTask.status === "done";
            })
                ? "ready"
                : "blocked");

        const fullTask: Task = { ...task, dependencies: deps, status };

        // Temporarily insert to check for cycles
        this.tasks.set(fullTask.id, fullTask);
        try {
            this.detectCycle(fullTask.id);
        } catch {
            this.tasks.delete(fullTask.id);
            throw new Error(`Dependency cycle detected involving task "${fullTask.id}"`);
        }

        this.recalculateStatuses();
    }

    getTask(id: string): Task | undefined {
        return this.tasks.get(id);
    }

    getAllTasks(): Task[] {
        return Array.from(this.tasks.values());
    }

    getReadyTasks(): Task[] {
        return Array.from(this.tasks.values())
            .filter((t) => t.status === "ready")
            .sort((a, b) => a.dependencies.length - b.dependencies.length || a.id.localeCompare(b.id));
    }

    claimTasks(count: number): Task[] {
        const ready = this.getReadyTasks();
        const toClaim = ready.slice(0, count);

        for (const task of toClaim) {
            task.status = "claimed";
        }

        return toClaim;
    }

    startTask(id: string, agentId: string): void {
        const task = this.tasks.get(id);
        if (!task) throw new Error(`Task "${id}" not found`);
        if (task.status !== "claimed") {
            throw new Error(`Task "${id}" must be "claimed" to start, got "${task.status}"`);
        }

        task.status = "implementing";
        task.assignedAgent = agentId;
    }

    submitForReview(id: string, result: unknown): void {
        const task = this.tasks.get(id);
        if (!task) throw new Error(`Task "${id}" not found`);
        if (task.status !== "implementing") {
            throw new Error(`Task "${id}" must be "implementing" to submit for review, got "${task.status}"`);
        }

        task.status = "reviewing";
        task.result = result;
    }

    completeTask(id: string): void {
        const task = this.tasks.get(id);
        if (!task) throw new Error(`Task "${id}" not found`);
        if (task.status !== "reviewing") {
            throw new Error(`Task "${id}" must be "reviewing" to complete, got "${task.status}"`);
        }

        task.status = "done";
        this.recalculateStatuses();
    }

    rejectTask(id: string, reason: string): void {
        const task = this.tasks.get(id);
        if (!task) throw new Error(`Task "${id}" not found`);
        if (task.status !== "reviewing") {
            throw new Error(`Task "${id}" must be "reviewing" to reject, got "${task.status}"`);
        }

        task.status = "ready";
        task.reviewFeedback = reason;
    }

    recalculateStatuses(): void {
        for (const task of this.tasks.values()) {
            if (task.status === "blocked") {
                const allDepsDone = task.dependencies.every((dep) => {
                    const depTask = this.tasks.get(dep);
                    return depTask !== undefined && depTask.status === "done";
                });
                if (allDepsDone) {
                    task.status = "ready";
                }
            }
        }
    }

    toJSON(): { tasks: Task[] } {
        return { tasks: this.getAllTasks() };
    }

    static fromJSON(data: { tasks: Task[] }): TaskTracker {
        const tracker = new TaskTracker();
        for (const task of data.tasks) {
            tracker.tasks.set(task.id, structuredClone(task));
        }
        // Validate no cycles in deserialized data
        for (const id of tracker.tasks.keys()) {
            tracker.detectCycle(id);
        }
        tracker.recalculateStatuses();
        return tracker;
    }

    areAllDone(): boolean {
        const all = this.getAllTasks();
        return all.length > 0 && all.every((t) => t.status === "done");
    }

    private detectCycle(startId: string): void {
        const visited = new Set<string>();
        const stack = new Set<string>();

        const dfs = (id: string): void => {
            if (stack.has(id)) {
                throw new Error(`Cycle detected at "${id}"`);
            }
            if (visited.has(id)) return;

            visited.add(id);
            stack.add(id);

            const task = this.tasks.get(id);
            if (task) {
                for (const dep of task.dependencies) {
                    if (this.tasks.has(dep)) {
                        dfs(dep);
                    }
                }
            }

            stack.delete(id);
        };

        dfs(startId);
    }
}
