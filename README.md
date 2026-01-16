# dagflowjs

A lightweight, type-safe DAG (Directed Acyclic Graph) execution engine for TypeScript. Execute complex workflows with dependency management, parallel execution, retries, timeouts, and comprehensive metrics.

## Features

- 🔄 **Dependency Management**: Define node dependencies and execute in the correct order
- ⚡ **Parallel Execution**: Automatically runs independent nodes in parallel
- 🔁 **Retry Logic**: Configurable retries with exponential backoff
- ⏱️ **Timeouts**: Set timeouts per node to prevent hanging operations
- 📊 **Metrics**: Track execution time, attempts, and success rates
- ✅ **Validation**: Pre-execution validation hooks
- 🧹 **Cleanup**: Post-execution cleanup hooks
- 🛡️ **Error Strategies**: Choose to fail or skip nodes on error
- 📝 **TypeScript**: Full type safety with generic context types

## Installation

```bash
npm install dagflowjs
```

## Quick Start

```typescript
import { DagEngine, DagNode } from 'dagflowjs';

// Define your context type
interface OrderContext {
  orderId: string;
  userId: string;
  paymentId?: string;
  inventoryReserved: boolean;
  shippingLabel?: string;
  orderStatus: 'pending' | 'processing' | 'completed' | 'failed';
}

// Create a logger
const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
};

// Create the engine
const engine = new DagEngine<OrderContext>({ logger });

// Add nodes
engine
  .addNode({
    id: 'validate-order',
    execute: async (ctx) => {
      // Validate order exists
      return { orderStatus: 'processing' as const };
    },
  })
  .addNode({
    id: 'process-payment',
    dependsOn: ['validate-order'],
    config: { maxRetries: 3, retryDelayMs: 1000, timeoutMs: 30000 },
    execute: async (ctx) => {
      // Process payment
      return { paymentId: 'pay_12345' };
    },
  })
  .addNode({
    id: 'reserve-inventory',
    dependsOn: ['validate-order'],
    config: { maxRetries: 2, timeoutMs: 15000 },
    execute: async (ctx) => {
      // Reserve inventory
      return { inventoryReserved: true };
    },
  })
  .addNode({
    id: 'create-shipping-label',
    dependsOn: ['process-payment', 'reserve-inventory'],
    config: { timeoutMs: 20000 },
    execute: async (ctx) => {
      // Create shipping label
      return { shippingLabel: 'LABEL_67890' };
    },
  })
  .addNode({
    id: 'complete-order',
    dependsOn: ['create-shipping-label'],
    execute: async (ctx) => {
      // Mark order as completed
      return { orderStatus: 'completed' as const };
    },
  });

// Execute the workflow
const result = await engine.execute({
  orderId: 'ORD_001',
  userId: 'USER_123',
  inventoryReserved: false,
  orderStatus: 'pending',
});

if (result.success) {
  console.log('Order processed successfully:', result.context);
  console.log('Metrics:', result.metrics);
} else {
  console.error('Order processing failed:', result.error);
}
```

## Real-World Example: E-Commerce Order Processing Pipeline

Here's a complete example of an order processing workflow that demonstrates the power of dagflowjs:

```typescript
import { DagEngine, DagNode, Logger } from 'dagflowjs';

// Define the order processing context
interface OrderContext {
  orderId: string;
  userId: string;
  items: Array<{ productId: string; quantity: number }>;
  paymentMethod: 'credit_card' | 'paypal' | 'bank_transfer';
  
  // Results from each node
  customerValidated?: boolean;
  paymentId?: string;
  paymentStatus?: 'pending' | 'completed' | 'failed';
  inventoryReserved?: boolean;
  inventoryItems?: Array<{ productId: string; reserved: boolean }>;
  shippingAddress?: {
    street: string;
    city: string;
    zipCode: string;
    country: string;
  };
  shippingLabelId?: string;
  shippingCost?: number;
  emailSent?: boolean;
  orderStatus: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
}

// Mock API functions (replace with real implementations)
async function validateCustomer(userId: string): Promise<boolean> {
  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 100));
  return true;
}

async function processPayment(
  orderId: string,
  amount: number,
  method: string
): Promise<{ paymentId: string; status: 'completed' }> {
  await new Promise(resolve => setTimeout(resolve, 200));
  return { paymentId: `pay_${Date.now()}`, status: 'completed' as const };
}

async function reserveInventory(
  items: Array<{ productId: string; quantity: number }>
): Promise<Array<{ productId: string; reserved: boolean }>> {
  await new Promise(resolve => setTimeout(resolve, 150));
  return items.map(item => ({ productId: item.productId, reserved: true }));
}

async function getShippingAddress(userId: string): Promise<OrderContext['shippingAddress']> {
  await new Promise(resolve => setTimeout(resolve, 100));
  return {
    street: '123 Main St',
    city: 'New York',
    zipCode: '10001',
    country: 'USA',
  };
}

async function createShippingLabel(
  address: OrderContext['shippingAddress'],
  items: Array<{ productId: string; quantity: number }>
): Promise<{ labelId: string; cost: number }> {
  await new Promise(resolve => setTimeout(resolve, 300));
  return { labelId: `label_${Date.now()}`, cost: 15.99 };
}

async function sendOrderConfirmationEmail(
  userId: string,
  orderId: string
): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, 100));
  return true;
}

// Create logger
const logger: Logger = {
  info: (msg: string, meta?: any) => {
    console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta, null, 2) : '');
  },
  warn: (msg: string, meta?: any) => {
    console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta, null, 2) : '');
  },
  error: (msg: string, meta?: any) => {
    console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta, null, 2) : '');
  },
};

// Build the order processing pipeline
function createOrderProcessingEngine(): DagEngine<OrderContext> {
  const engine = new DagEngine<OrderContext>({ logger });

  // Node 1: Validate customer (no dependencies)
  engine.addNode({
    id: 'validate-customer',
    config: {
      timeoutMs: 5000,
      maxRetries: 2,
      retryDelayMs: 500,
    },
    execute: async (ctx, deps) => {
      deps.logger.info(`Validating customer ${ctx.userId}`);
      const isValid = await validateCustomer(ctx.userId);
      if (!isValid) {
        throw new Error('Customer validation failed');
      }
      return { customerValidated: true };
    },
  });

  // Node 2: Process payment (depends on customer validation)
  engine.addNode({
    id: 'process-payment',
    dependsOn: ['validate-customer'],
    config: {
      timeoutMs: 30000,
      maxRetries: 3,
      retryDelayMs: 1000,
      onError: 'fail', // Fail the entire workflow if payment fails
    },
    validate: async (ctx) => {
      // Only process payment if customer is validated
      return ctx.customerValidated === true;
    },
    execute: async (ctx, deps) => {
      deps.logger.info(`Processing payment for order ${ctx.orderId}`);
      const total = ctx.items.reduce((sum, item) => sum + item.quantity * 10, 0);
      const result = await processPayment(ctx.orderId, total, ctx.paymentMethod);
      return {
        paymentId: result.paymentId,
        paymentStatus: result.status,
      };
    },
  });

  // Node 3: Reserve inventory (depends on customer validation, runs in parallel with payment)
  engine.addNode({
    id: 'reserve-inventory',
    dependsOn: ['validate-customer'],
    config: {
      timeoutMs: 20000,
      maxRetries: 2,
      retryDelayMs: 500,
    },
    execute: async (ctx, deps) => {
      deps.logger.info(`Reserving inventory for order ${ctx.orderId}`);
      const reserved = await reserveInventory(ctx.items);
      return {
        inventoryReserved: reserved.every(item => item.reserved),
        inventoryItems: reserved,
      };
    },
  });

  // Node 4: Get shipping address (depends on customer validation)
  engine.addNode({
    id: 'get-shipping-address',
    dependsOn: ['validate-customer'],
    config: {
      timeoutMs: 10000,
      maxRetries: 1,
    },
    execute: async (ctx, deps) => {
      deps.logger.info(`Fetching shipping address for user ${ctx.userId}`);
      const address = await getShippingAddress(ctx.userId);
      return { shippingAddress: address };
    },
  });

  // Node 5: Create shipping label (depends on payment, inventory, and address)
  engine.addNode({
    id: 'create-shipping-label',
    dependsOn: ['process-payment', 'reserve-inventory', 'get-shipping-address'],
    config: {
      timeoutMs: 30000,
      maxRetries: 2,
    },
    validate: async (ctx) => {
      // Ensure all prerequisites are met
      return (
        ctx.paymentStatus === 'completed' &&
        ctx.inventoryReserved === true &&
        ctx.shippingAddress !== undefined
      );
    },
    execute: async (ctx, deps) => {
      deps.logger.info(`Creating shipping label for order ${ctx.orderId}`);
      if (!ctx.shippingAddress) {
        throw new Error('Shipping address is required');
      }
      const label = await createShippingLabel(ctx.shippingAddress, ctx.items);
      return {
        shippingLabelId: label.labelId,
        shippingCost: label.cost,
      };
    },
  });

  // Node 6: Send confirmation email (depends on shipping label, can fail without breaking workflow)
  engine.addNode({
    id: 'send-confirmation-email',
    dependsOn: ['create-shipping-label'],
    config: {
      timeoutMs: 10000,
      maxRetries: 2,
      onError: 'skip', // Don't fail the order if email fails
    },
    execute: async (ctx, deps) => {
      deps.logger.info(`Sending confirmation email for order ${ctx.orderId}`);
      const sent = await sendOrderConfirmationEmail(ctx.userId, ctx.orderId);
      return { emailSent: sent };
    },
  });

  // Node 7: Complete order (depends on shipping label)
  engine.addNode({
    id: 'complete-order',
    dependsOn: ['create-shipping-label'],
    execute: async (ctx, deps) => {
      deps.logger.info(`Completing order ${ctx.orderId}`);
      return { orderStatus: 'completed' as const };
    },
    cleanup: async (ctx) => {
      // Cleanup hook - could be used for logging, notifications, etc.
      deps.logger.info(`Order ${ctx.orderId} processing completed`);
    },
  });

  return engine;
}

// Usage example
async function processOrder() {
  const engine = createOrderProcessingEngine();

  const initialContext: OrderContext = {
    orderId: 'ORD_12345',
    userId: 'USER_789',
    items: [
      { productId: 'PROD_001', quantity: 2 },
      { productId: 'PROD_002', quantity: 1 },
    ],
    paymentMethod: 'credit_card',
    orderStatus: 'pending',
  };

  console.log('Starting order processing...\n');
  const result = await engine.execute(initialContext);

  if (result.success) {
    console.log('\n✅ Order processed successfully!');
    console.log('Final context:', JSON.stringify(result.context, null, 2));
    console.log('\n📊 Execution Metrics:');
    console.log(`  Total nodes: ${result.metrics.totalNodes}`);
    console.log(`  Successful: ${result.metrics.successfulNodes}`);
    console.log(`  Failed: ${result.metrics.failedNodes}`);
    console.log(`  Skipped: ${result.metrics.skippedNodes}`);
    console.log(`  Duration: ${(result.metrics.finishedAt! - result.metrics.startedAt) / 1000}s`);
    console.log('\n📈 Node Details:');
    Object.entries(result.metrics.nodes).forEach(([nodeId, metrics]) => {
      console.log(`  ${nodeId}:`);
      console.log(`    Status: ${metrics.status}`);
      console.log(`    Attempts: ${metrics.attempts}`);
      console.log(`    Duration: ${metrics.durationMs}ms`);
      if (metrics.error) {
        console.log(`    Error: ${metrics.error}`);
      }
    });
  } else {
    console.error('\n❌ Order processing failed!');
    console.error('Error:', result.error?.message);
    console.error('Context at failure:', JSON.stringify(result.context, null, 2));
    console.error('Metrics:', result.metrics);
  }
}

// Run the example
processOrder().catch(console.error);
```

### Example Output

When you run this example, you'll see:

```
Starting order processing...

[INFO] Validating customer USER_789
[INFO] Processing payment for order ORD_12345
[INFO] Reserving inventory for order ORD_12345
[INFO] Fetching shipping address for user USER_789
[INFO] Creating shipping label for order ORD_12345
[INFO] Sending confirmation email for order ORD_12345
[INFO] Completing order ORD_12345
[INFO] Order ORD_12345 processing completed

✅ Order processed successfully!
Final context: {
  "orderId": "ORD_12345",
  "userId": "USER_789",
  "items": [...],
  "paymentMethod": "credit_card",
  "customerValidated": true,
  "paymentId": "pay_1234567890",
  "paymentStatus": "completed",
  "inventoryReserved": true,
  "shippingLabelId": "label_1234567890",
  "shippingCost": 15.99,
  "emailSent": true,
  "orderStatus": "completed"
}

📊 Execution Metrics:
  Total nodes: 7
  Successful: 7
  Failed: 0
  Skipped: 0
  Duration: 0.85s

📈 Node Details:
  validate-customer:
    Success: true
    Attempts: 1
    Duration: 102ms
  process-payment:
    Success: true
    Attempts: 1
    Duration: 203ms
  reserve-inventory:
    Success: true
    Attempts: 1
    Duration: 152ms
  ...
```

## API Reference

### `DagEngine<T>`

The main engine class for executing DAG workflows.

#### Constructor

```typescript
new DagEngine<T>(deps: DagNodeDeps)
```

#### Methods

- `addNode(node: DagNode<T>): this` - Add a node to the workflow
- `execute(initial: T): Promise<DagResult<T>>` - Execute the workflow

### `DagNode<T, Patch>`

Interface for defining workflow nodes.

```typescript
interface DagNode<T, Patch = Partial<T>> {
  id: string;
  dependsOn?: string[];
  config?: DagNodeConfig;
  execute(ctx: Readonly<T>, deps: DagNodeDeps, signal: AbortSignal): Promise<Patch>;
  validate?(ctx: T): boolean | Promise<boolean>;
  cleanup?(ctx: T): void | Promise<void>;
}
```

### `DagNodeConfig`

Configuration options for a node.

```typescript
interface DagNodeConfig {
  timeoutMs?: number;           // Node timeout in milliseconds
  maxRetries?: number;         // Maximum retry attempts (default: 0)
  retryDelayMs?: number;       // Base delay between retries (default: 500ms)
  onError?: 'fail' | 'skip' | 'skip-dependents';  // Error handling strategy (default: 'fail')
}
```

### `DagResult<T>`

Result of workflow execution.

```typescript
interface DagResult<T> {
  success: boolean;
  context: T;
  metrics: DagMetrics;
  error?: Error;
}
```

## Development

- Install dependencies:

```bash
npm install
```

- Run the unit tests:

```bash
npm run test
```

- Build the library:

```bash
npm run build
```

## License

MIT
