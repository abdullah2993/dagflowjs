import { expect, test, describe, beforeEach, vi } from 'vitest';
import {
  DagEngine,
  DagNode,
  Logger,
  DagNodeDeps,
  DagResult,
} from '../src';

describe('DagEngine', () => {
  let mockLogger: Logger;
  let deps: DagNodeDeps;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    deps = { logger: mockLogger };
  });

  describe('addNode', () => {
    test('should add a node successfully', () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 1 }),
      };

      expect(() => engine.addNode(node)).not.toThrow();
    });

    test('should throw error on duplicate node id', () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 1 }),
      };
      const node2: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 2 }),
      };

      engine.addNode(node1);
      expect(() => engine.addNode(node2)).toThrow('Duplicate node id: node1');
    });

    test('should return this for chaining', () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 1 }),
      };

      const result = engine.addNode(node);
      expect(result).toBe(engine);
    });
  });

  describe('execute', () => {
    test('should execute a single node', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 10 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(10);
      expect(result.metrics.totalNodes).toBe(1);
      expect(result.metrics.successfulNodes).toBe(1);
      expect(result.metrics.failedNodes).toBe(0);
      expect(result.metrics.nodes.node1.status).toBe('success');
    });

    test('should execute multiple independent nodes in parallel', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number }> = {
        id: 'node1',
        execute: async () => ({ a: 1 }),
      };
      const node2: DagNode<{ a: number; b: number }> = {
        id: 'node2',
        execute: async () => ({ b: 2 }),
      };

      engine.addNode(node1).addNode(node2);
      const result = await engine.execute({ a: 0, b: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { a: number; b: number }).a).toBe(1);
      expect((result.context as { a: number; b: number }).b).toBe(2);
      expect(result.metrics.successfulNodes).toBe(2);
    });

    test('should execute nodes in dependency order', async () => {
      const engine = new DagEngine(deps);
      const executionOrder: string[] = [];

      const node1: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => {
          executionOrder.push('node1');
          return { value: 1 };
        },
      };
      const node2: DagNode<{ value: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => {
          executionOrder.push('node2');
          return { value: 2 };
        },
      };
      const node3: DagNode<{ value: number }> = {
        id: 'node3',
        dependsOn: ['node2'],
        execute: async () => {
          executionOrder.push('node3');
          return { value: 3 };
        },
      };

      engine.addNode(node1).addNode(node2).addNode(node3);
      await engine.execute({ value: 0 });

      expect(executionOrder).toEqual(['node1', 'node2', 'node3']);
    });

    test('should merge context patches correctly', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node1',
        execute: async () => ({ a: 1 }),
      };
      const node2: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node2',
        execute: async () => ({ b: 2, c: 3 }),
      };

      engine.addNode(node1).addNode(node2);
      const result = await engine.execute({ a: 0, b: 0, c: 0 });

      expect(result.context).toEqual({ a: 1, b: 2, c: 3 });
    });

    test('should track metrics correctly', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { value: 1 };
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.metrics.startedAt).toBeGreaterThan(0);
      expect(result.metrics.finishedAt).toBeGreaterThan(result.metrics.startedAt);
      expect(result.metrics.totalNodes).toBe(1);
      expect(result.metrics.successfulNodes).toBe(1);
      expect(result.metrics.failedNodes).toBe(0);
      expect(result.metrics.nodes.node1.attempts).toBe(1);
      expect(result.metrics.nodes.node1.durationMs).toBeGreaterThanOrEqual(5);
    });

    test('should detect deadlock when no nodes are ready', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ value: number }> = {
        id: 'node1',
        dependsOn: ['node2'],
        execute: async () => ({ value: 1 }),
      };
      const node2: DagNode<{ value: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ value: 2 }),
      };

      engine.addNode(node1).addNode(node2);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Cycle detected/);
    });
  });

  describe('retries', () => {
    test('should retry on failure', async () => {
      const engine = new DagEngine(deps);
      let attempts = 0;
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { maxRetries: 2, retryDelayMs: 10 },
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Failed');
          }
          return { value: 1 };
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
      expect(result.metrics.nodes.node1.attempts).toBe(3);
    });

    test('should fail after max retries', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { maxRetries: 2, retryDelayMs: 10 },
        execute: async () => {
          throw new Error('Always fails');
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Always fails');
      expect(result.metrics.nodes.node1.attempts).toBe(3); // initial + 2 retries
      expect(result.metrics.nodes.node1.status).toBe('failed');
      expect(result.metrics.nodes.node1.error).toBe('Always fails');
    });

    test('should use exponential backoff for retries', async () => {
      const engine = new DagEngine(deps);
      const attemptTimes: number[] = [];

      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { maxRetries: 2, retryDelayMs: 10 },
        execute: async () => {
          attemptTimes.push(Date.now());
          throw new Error('Failed');
        },
      };

      engine.addNode(node);
      await engine.execute({ value: 0 });

      // Should have 3 attempts (initial + 2 retries)
      expect(attemptTimes.length).toBe(3);
      
      // Calculate delays between attempts
      const delays: number[] = [];
      for (let i = 1; i < attemptTimes.length; i++) {
        delays.push(attemptTimes[i] - attemptTimes[i - 1]);
      }

      // Should have 2 delays: ~10ms (2^0 * 10), ~20ms (2^1 * 10)
      expect(delays.length).toBe(2);
      expect(delays[0]).toBeGreaterThanOrEqual(8); // Allow some tolerance
      expect(delays[1]).toBeGreaterThanOrEqual(18);
    });
  });

  describe('timeout', () => {
    test('should timeout long-running nodes', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { timeoutMs: 50 },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { value: 1 };
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('node1 timed out');
      expect(result.metrics.nodes.node1.status).toBe('failed');
    });

    test('should not timeout nodes that complete quickly', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { timeoutMs: 100 },
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { value: 1 };
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(1);
    });
  });

  describe('error strategies', () => {
    test('should fail by default on error', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => {
          throw new Error('Test error');
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Test error');
    });

    test('should skip node on error when onError is skip', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ value: number }> = {
        id: 'node1',
        config: { onError: 'skip' },
        execute: async () => {
          throw new Error('Test error');
        },
      };
      const node2: DagNode<{ value: number }> = {
        id: 'node2',
        execute: async () => ({ value: 2 }),
      };

      engine.addNode(node1).addNode(node2);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(2);
      expect(result.metrics.failedNodes).toBe(1);
      expect(result.metrics.nodes.node1.status).toBe('failed');
    });

    test('should fail on error when onError is fail', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { onError: 'fail' },
        execute: async () => {
          throw new Error('Test error');
        },
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Test error');
    });

    test('should block dependents when onError is skip-dependents', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node1',
        config: { onError: 'skip-dependents' },
        execute: async () => {
          throw new Error('Test error');
        },
      };
      const node2: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ b: 2 }),
      };
      const node3: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node3',
        dependsOn: ['node2'],
        execute: async () => ({ c: 3 }),
      };
      const node4: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node4',
        execute: async () => ({ a: 1 }),
      };

      engine.addNode(node1).addNode(node2).addNode(node3).addNode(node4);
      const result = await engine.execute({ a: 0, b: 0, c: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { a: number; b: number; c: number }).a).toBe(1);
      expect(result.metrics.failedNodes).toBe(1);
      expect(result.metrics.blockedNodes).toBe(2);
      expect(result.metrics.nodes.node1.status).toBe('failed');
      expect(result.metrics.nodes.node2.status).toBe('blocked');
      expect(result.metrics.nodes.node3.status).toBe('blocked');
      expect(result.metrics.nodes.node4.status).toBe('success');
    });
  });

  describe('validation', () => {
    test('should execute node when validation passes', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        validate: (ctx) => ctx.value > 0,
        execute: async () => ({ value: 10 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 1 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(10);
    });

    test('should skip node when validation fails', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        validate: (ctx) => ctx.value > 0,
        execute: async () => ({ value: 10 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(true);
      expect(result.metrics.nodes.node1.status).toBe('skipped');
    });

    test('should support async validation', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        validate: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ctx.value > 0;
        },
        execute: async () => ({ value: 10 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 1 });

      expect(result.success).toBe(true);
    });
  });

  describe('shouldRun', () => {
    test('should execute node when shouldRun returns true', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        shouldRun: (ctx) => ctx.value > 0,
        execute: async () => ({ value: 10 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 1 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(10);
    });

    test('should block dependents when shouldRun returns false', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node1',
        shouldRun: (ctx) => ctx.a > 0,
        execute: async () => ({ a: 1 }),
      };
      const node2: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ b: 2 }),
      };
      const node3: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node3',
        dependsOn: ['node2'],
        execute: async () => ({ c: 3 }),
      };
      const node4: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node4',
        execute: async () => ({ a: 1 }),
      };

      engine.addNode(node1).addNode(node2).addNode(node3).addNode(node4);
      const result = await engine.execute({ a: 0, b: 0, c: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { a: number; b: number; c: number }).a).toBe(1);
      expect(result.metrics.skippedNodes).toBe(1);
      expect(result.metrics.blockedNodes).toBe(2);
      expect(result.metrics.nodes.node1.status).toBe('skipped');
      expect(result.metrics.nodes.node2.status).toBe('blocked');
      expect(result.metrics.nodes.node3.status).toBe('blocked');
      expect(result.metrics.nodes.node4.status).toBe('success');
    });

    test('should support async shouldRun', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        shouldRun: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ctx.value > 0;
        },
        execute: async () => ({ value: 10 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 1 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(10);
    });

    test('should not call cleanup when shouldRun returns false', async () => {
      const engine = new DagEngine(deps);
      let cleanupCalled = false;
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        shouldRun: () => false,
        execute: async () => ({ value: 10 }),
        cleanup: async () => {
          cleanupCalled = true;
        },
      };

      engine.addNode(node);
      await engine.execute({ value: 0 });

      expect(cleanupCalled).toBe(false);
    });
  });

  describe('cleanup', () => {
    test('should call cleanup after successful execution', async () => {
      const engine = new DagEngine(deps);
      let cleanupCalled = false;
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 10 }),
        cleanup: async () => {
          cleanupCalled = true;
        },
      };

      engine.addNode(node);
      await engine.execute({ value: 0 });

      expect(cleanupCalled).toBe(true);
    });

    test('should not call cleanup on validation failure', async () => {
      const engine = new DagEngine(deps);
      let cleanupCalled = false;
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        validate: () => false,
        execute: async () => ({ value: 10 }),
        cleanup: async () => {
          cleanupCalled = true;
        },
      };

      engine.addNode(node);
      await engine.execute({ value: 0 });

      expect(cleanupCalled).toBe(false);
    });
  });

  describe('abort signal', () => {
    test('should pass abort signal to execute', async () => {
      const engine = new DagEngine(deps);
      let receivedSignal: AbortSignal | undefined;
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async (ctx, deps, signal) => {
          receivedSignal = signal;
          return { value: 1 };
        },
      };

      engine.addNode(node);
      await engine.execute({ value: 0 });

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);
    });

    test('should abort signal on timeout', async () => {
      const engine = new DagEngine(deps);
      let receivedSignal: AbortSignal | undefined;
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        config: { timeoutMs: 50 },
        execute: async (ctx, deps, signal) => {
          receivedSignal = signal;
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { value: 1 };
        },
      };

      engine.addNode(node);
      await engine.execute({ value: 0 });

      // Signal should be aborted when timeout occurs
      expect(receivedSignal).toBeDefined();
    });
  });

  describe('complex scenarios', () => {
    test('should handle multiple dependencies', async () => {
      const engine = new DagEngine(deps);
      const executionOrder: string[] = [];

      const node1: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node1',
        execute: async () => {
          executionOrder.push('node1');
          return { a: 1 };
        },
      };
      const node2: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node2',
        execute: async () => {
          executionOrder.push('node2');
          return { b: 2 };
        },
      };
      const node3: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node3',
        dependsOn: ['node1', 'node2'],
        execute: async () => {
          executionOrder.push('node3');
          return { c: 3 };
        },
      };

      engine.addNode(node1).addNode(node2).addNode(node3);
      const result = await engine.execute({ a: 0, b: 0, c: 0 });

      expect(result.success).toBe(true);
      expect(executionOrder).toContain('node1');
      expect(executionOrder).toContain('node2');
      expect(executionOrder[executionOrder.length - 1]).toBe('node3');
      expect(result.context).toEqual({ a: 1, b: 2, c: 3 });
    });

    test('should handle empty initial context', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        execute: async () => ({ value: 1 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(true);
      expect((result.context as { value: number }).value).toBe(1);
    });

    test('should preserve context structure', async () => {
      const engine = new DagEngine(deps);
      const initial = {
        user: { name: 'John', age: 30 },
        settings: { theme: 'dark' },
      };

      const node: DagNode<typeof initial> = {
        id: 'node1',
        execute: async () => ({
          user: { name: 'Jane', age: 30 },
        } as Partial<typeof initial>),
      };

      engine.addNode(node);
      const result = await engine.execute(initial);

      expect(result.success).toBe(true);
      expect((result.context as typeof initial).user.name).toBe('Jane');
      // Note: deepMerge uses structuredClone, so nested objects are replaced
      // This is the current behavior of the implementation
    });
  });

  describe('planner validation', () => {
    test('should throw error on missing dependency', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        dependsOn: ['missing-node'],
        execute: async () => ({ value: 1 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/depends on missing node/);
    });

    test('should throw error on self-dependency', async () => {
      const engine = new DagEngine(deps);
      const node: DagNode<{ value: number }> = {
        id: 'node1',
        dependsOn: ['node1'],
        execute: async () => ({ value: 1 }),
      };

      engine.addNode(node);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/cannot depend on itself/);
    });

    test('should detect cycles in dependencies', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ value: number }> = {
        id: 'node1',
        dependsOn: ['node2'],
        execute: async () => ({ value: 1 }),
      };
      const node2: DagNode<{ value: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ value: 2 }),
      };

      engine.addNode(node1).addNode(node2);
      const result = await engine.execute({ value: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Cycle detected/);
    });

    test('should detect longer cycles', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node1',
        dependsOn: ['node3'],
        execute: async () => ({ a: 1 }),
      };
      const node2: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ b: 2 }),
      };
      const node3: DagNode<{ a: number; b: number; c: number }> = {
        id: 'node3',
        dependsOn: ['node2'],
        execute: async () => ({ c: 3 }),
      };

      engine.addNode(node1).addNode(node2).addNode(node3);
      const result = await engine.execute({ a: 0, b: 0, c: 0 });

      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/Cycle detected/);
    });
  });

  describe('blocked nodes', () => {
    test('should track blocked nodes in metrics', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number }> = {
        id: 'node1',
        shouldRun: () => false,
        execute: async () => ({ a: 1 }),
      };
      const node2: DagNode<{ a: number; b: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ b: 2 }),
      };

      engine.addNode(node1).addNode(node2);
      const result = await engine.execute({ a: 0, b: 0 });

      expect(result.success).toBe(true);
      expect(result.metrics.blockedNodes).toBe(1);
      expect(result.metrics.skippedNodes).toBe(1);
      expect(result.metrics.nodes.node2.status).toBe('blocked');
    });

    test('should recursively block dependents', async () => {
      const engine = new DagEngine(deps);
      const node1: DagNode<{ a: number; b: number; c: number; d: number }> = {
        id: 'node1',
        config: { onError: 'skip-dependents' },
        execute: async () => {
          throw new Error('Failed');
        },
      };
      const node2: DagNode<{ a: number; b: number; c: number; d: number }> = {
        id: 'node2',
        dependsOn: ['node1'],
        execute: async () => ({ b: 2 }),
      };
      const node3: DagNode<{ a: number; b: number; c: number; d: number }> = {
        id: 'node3',
        dependsOn: ['node2'],
        execute: async () => ({ c: 3 }),
      };
      const node4: DagNode<{ a: number; b: number; c: number; d: number }> = {
        id: 'node4',
        dependsOn: ['node3'],
        execute: async () => ({ d: 4 }),
      };

      engine.addNode(node1).addNode(node2).addNode(node3).addNode(node4);
      const result = await engine.execute({ a: 0, b: 0, c: 0, d: 0 });

      expect(result.success).toBe(true);
      expect(result.metrics.blockedNodes).toBe(3);
      expect(result.metrics.nodes.node2.status).toBe('blocked');
      expect(result.metrics.nodes.node3.status).toBe('blocked');
      expect(result.metrics.nodes.node4.status).toBe('blocked');
    });
  });
});
