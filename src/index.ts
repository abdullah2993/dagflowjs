export interface Logger {
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
}

export type ErrorStrategy = "fail" | "skip" | "skip-dependents";

export type DagNodeStatus =
  | "success"
  | "failed"
  | "skipped"
  | "blocked";

export interface DagNodeConfig {
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onError?: ErrorStrategy;
}

export interface DagNodeMetrics {
  attempts: number;
  status: DagNodeStatus;
  durationMs: number;
  error?: string;
}

export interface DagMetrics {
  startedAt: number;
  finishedAt?: number;
  totalNodes: number;
  successfulNodes: number;
  failedNodes: number;
  skippedNodes: number;
  blockedNodes: number;
  nodes: Record<string, DagNodeMetrics>;
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

  shouldRun?(ctx: T): boolean | Promise<boolean>;
  execute(
    ctx: Readonly<T>,
    deps: DagNodeDeps,
    signal: AbortSignal
  ): Promise<Patch>;

  validate?(ctx: T): boolean | Promise<boolean>;
  cleanup?(ctx: T): void | Promise<void>;
}
class SkipSuccessors extends Error {
  constructor(public readonly nodeId: string) {
    super(`Node ${nodeId} gated off successors`);
  }
}

export interface DagPlan {
  order: string[];          
  batches: string[][];      
}

export class DagEngine<T> {
  private nodes = new Map<string, DagNode<T>>();
  private nodesArray: DagNode<T>[] = [];
  private executionPlan: DagPlan | null = null;
  private planner: (node: DagNode<T>[]) => DagPlan;

  constructor(private deps: DagNodeDeps, planner?: (node: DagNode<T>[]) => DagPlan) {
    this.planner = planner ?? defaultPlanner;
  }

  addNode(node: DagNode<T>): this {
    if (this.nodes.has(node.id)) {
      throw new Error(`Duplicate node id: ${node.id}`);
    }
    this.nodes.set(node.id, node);
    this.nodesArray.push(node);
    this.executionPlan = null;
    return this;
  }

  plan(): DagPlan {
    if (this.executionPlan) {
      return this.executionPlan;
    }
    this.executionPlan = this.planner(this.nodesArray);
    return this.executionPlan;
  }

  async execute(initial: T): Promise<DagResult<T>> {
    const startedAt = Date.now();
    let ctx = structuredClone(initial);

    const metrics: DagMetrics = {
      startedAt,
      totalNodes: 0,
      successfulNodes: 0,
      failedNodes: 0,
      skippedNodes: 0,
      blockedNodes: 0,
      nodes: {},
    };

    const completed = new Set<string>();
    const failed = new Set<string>();
    const blocked = new Set<string>();

    try {
      const nodes = [...this.nodes.values()];
      if (!this.executionPlan) {
        this.executionPlan = this.planner(nodes);
      }

      metrics.totalNodes = nodes.length;
      for (const batch of this.executionPlan.batches) {
        const runnable = batch
          .map(id => this.nodes.get(id)!)
          .filter(n => !blocked.has(n.id));

        const results = await Promise.all(
          runnable.map(node =>
            this.runNode(node, ctx, metrics)
              .then(patch => ({ node, patch }))
              .catch(err => ({ node, err }))
          )
        );

        for (const r of results) {
          if ("patch" in r) {
            ctx = mergeContext(ctx, r.patch);
            completed.add(r.node.id);
            metrics.successfulNodes++;
            continue;
          }

          if (r.err instanceof SkipSuccessors) {
            completed.add(r.node.id);
            this.blockDependents(r.node.id, nodes, blocked, metrics);
            continue;
          }

          failed.add(r.node.id);
          metrics.failedNodes++;

          const strategy = r.node.config?.onError ?? "fail";

          if (strategy === "fail") {
            throw r.err;
          }

          if (strategy === "skip-dependents") {
            this.blockDependents(r.node.id, nodes, blocked, metrics);
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


  private async runNode(
    node: DagNode<T>,
    ctx: T,
    metrics: DagMetrics
  ): Promise<Partial<T>> {
    const start = Date.now();

    if (node.shouldRun) {
      const run = await node.shouldRun(ctx);
      if (!run) {
        metrics.nodes[node.id] = {
          attempts: 0,
          status: "skipped",
          durationMs: 0,
        };
        metrics.skippedNodes++;
        throw new SkipSuccessors(node.id);
      }
    }

    if (node.validate) {
      const valid = await node.validate(ctx);
      if (!valid) {
        metrics.nodes[node.id] = {
          attempts: 0,
          status: "skipped",
          durationMs: 0,
        };
        metrics.skippedNodes++;
        return {};
      }
    }

    const retries = node.config?.maxRetries ?? 0;
    const delay = node.config?.retryDelayMs ?? 500;

    let attempts = 0;
    let lastError: Error | undefined;

    try {
      for (let i = 0; i <= retries; i++) {
        attempts++;
        const controller = new AbortController();

        try {
          const patch = await this.withTimeout(node, ctx, controller);
          metrics.nodes[node.id] = {
            attempts,
            status: "success",
            durationMs: Date.now() - start,
          };
          return patch;
        } catch (err) {
          lastError = err as Error;
          if (i < retries) {
            await sleep(delay * 2 ** i);
          }
        }
      }

      metrics.nodes[node.id] = {
        attempts,
        status: "failed",
        durationMs: Date.now() - start,
        error: lastError?.message,
      };

      throw lastError;

    } finally {
      await node.cleanup?.(ctx);
    }
  }

  private async withTimeout(
    node: DagNode<T>,
    ctx: T,
    controller: AbortController
  ): Promise<Partial<T>> {
    const timeoutMs = node.config?.timeoutMs;
    if (!timeoutMs) {
      return node.execute(ctx, this.deps, controller.signal);
    }

    let timeoutId!: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${node.id} timed out`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        node.execute(ctx, this.deps, controller.signal),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private blockDependents(
    nodeId: string,
    nodes: DagNode<T>[],
    blocked: Set<string>,
    metrics: DagMetrics
  ) {
    for (const node of nodes) {
      if ((node.dependsOn ?? []).includes(nodeId) && !blocked.has(node.id)) {
        blocked.add(node.id);
        metrics.nodes[node.id] = {
          attempts: 0,
          status: "blocked",
          durationMs: 0,
        };
        metrics.blockedNodes++;
        this.blockDependents(node.id, nodes, blocked, metrics);
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function mergeContext<T>(base: T, patch: Partial<T>): T {
  return structuredClone({ ...base, ...patch });
}


function defaultPlanner<T>(nodes: DagNode<T>[]): DagPlan {
  const graph = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  // init
  for (const node of nodes) {
    if (graph.has(node.id)) {
      throw new Error(`Duplicate node id: ${node.id}`);
    }
    graph.set(node.id, new Set());
    indegree.set(node.id, 0);
  }

  // build graph
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!graph.has(dep)) {
        throw new Error(
          `Node ${node.id} depends on missing node ${dep}`
        );
      }
      if (dep === node.id) {
        throw new Error(`Node ${node.id} cannot depend on itself`);
      }
      graph.get(dep)!.add(node.id);
      indegree.set(node.id, indegree.get(node.id)! + 1);
    }
  }

  // kahn with batching
  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  const batches: string[][] = [];

  while (queue.length) {
    const batchSize = queue.length;
    const batch: string[] = [];

    for (let i = 0; i < batchSize; i++) {
      const id = queue.shift()!;
      order.push(id);
      batch.push(id);

      for (const next of graph.get(id)!) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) {
          queue.push(next);
        }
      }
    }

    batches.push(batch);
  }

  if (order.length !== nodes.length) {
    const cycle = [...indegree.entries()]
      .filter(([, d]) => d > 0)
      .map(([id]) => id);
    throw new Error(`Cycle detected: ${cycle.join(" -> ")}`);
  }

  return { order, batches };
}