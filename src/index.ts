export interface Logger {
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}

export type ErrorStrategy = "fail" | "skip";

export interface DagNodeConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onError?: ErrorStrategy;
}

export interface DagNodeMetrics {
  attempts: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface DagMetrics {
  startedAt: number;
  finishedAt?: number;
  totalSteps: number;
  successfulSteps: number;
  failedSteps: number;
  skippedSteps: number;
  steps: Record<string, DagNodeMetrics>;
}

export interface DagResult<T> {
  success: boolean;
  context: T;
  metrics: DagMetrics;
  error?: Error;
}


export interface DagNodeDeps {
  logger: Logger;
}

export interface DagNode<T, Patch = Partial<T>> {
  id: string;
  dependsOn?: string[];
  config?: DagNodeConfig;

  execute(
    ctx: Readonly<T>,
    deps: DagNodeDeps,
    signal: AbortSignal
  ): Promise<Patch>;

  validate?(ctx: T): boolean | Promise<boolean>;
  cleanup?(ctx: T): void | Promise<void>;
}


export class DagEngine<T> {
  private steps = new Map<string, DagNode<T>>();
  private logger: Logger;

  constructor(private deps: DagNodeDeps) {
    this.logger = deps.logger;
  }

  addStep(step: DagNode<T>): this {
    if (this.steps.has(step.id)) {
      throw new Error(`Duplicate step id: ${step.id}`);
    }
    this.steps.set(step.id, step);
    return this;
  }

  async execute(initial: T): Promise<DagResult<T>> {
    const metrics: DagMetrics = {
      startedAt: Date.now(),
      totalSteps: this.steps.size,
      successfulSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
      steps: {},
    };

    let ctx: T = structuredClone(initial);
    const completed = new Set<string>();

    try {
      while (completed.size < this.steps.size) {
        const ready = [...this.steps.values()].filter(
          (step) =>
            !completed.has(step.id) &&
            step.config?.enabled !== false &&
            (step.dependsOn ?? []).every((d) => completed.has(d))
        );

        if (!ready.length) {
          throw new Error("DAG deadlock or cyclic dependency detected");
        }

        const executions = ready.map((step) =>
          this.runStep(step, ctx, metrics).then((patch) => ({
            step,
            patch,
          }))
        );

        const results = await Promise.allSettled(executions);

        for (const r of results) {
          if (r.status === "fulfilled") {
            ctx = deepMerge(ctx, r.value.patch);
            completed.add(r.value.step.id);
            metrics.successfulSteps++;
          } else {
            metrics.failedSteps++;
            throw r.reason;
          }
        }
      }

      metrics.finishedAt = Date.now();
      return { success: true, context: ctx, metrics };
    } catch (error) {
      metrics.finishedAt = Date.now();
      return {
        success: false,
        context: ctx,
        metrics,
        error: error as Error,
      };
    }
  }

  private async runStep(
    step: DagNode<T>,
    ctx: T,
    metrics: DagMetrics
  ): Promise<Partial<T>> {
    const start = Date.now();
    let attempts = 0;
    let lastError: Error | undefined;

    const retries = step.config?.maxRetries ?? 0;
    const delay = step.config?.retryDelayMs ?? 500;

    for (let attempt = 0; attempt <= retries; attempt++) {
      attempts++;
      const controller = new AbortController();

      try {
        if (step.validate && !(await step.validate(ctx))) {
          throw new Error(`Validation failed`);
        }

        const patch = await this.withTimeout(step, ctx, controller);

        metrics.steps[step.id] = {
          attempts,
          success: true,
          durationMs: Date.now() - start,
        };

        await step.cleanup?.(ctx);
        return patch;
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries) {
          await sleep(delay * 2 ** attempt);
        }
      }
    }

    metrics.steps[step.id] = {
      attempts,
      success: false,
      durationMs: Date.now() - start,
      error: lastError?.message,
    };

    if (step.config?.onError !== "skip") {
      throw lastError;
    }

    return {};
  }

  private async withTimeout(
    step: DagNode<T>,
    ctx: T,
    controller: AbortController
  ): Promise<Partial<T>> {
    const timeoutMs = step.config?.timeoutMs;

    if (!timeoutMs) {
      return step.execute(ctx, this.deps, controller.signal);
    }

    let timeoutId!: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${step.id} timed out`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        step.execute(ctx, this.deps, controller.signal),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  return structuredClone({ ...base, ...patch });
}
