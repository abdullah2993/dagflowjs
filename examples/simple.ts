import { DagEngine } from "../dist/index.mjs";

interface OrderContext {
  orderId: string;
  paymentId?: string;
  inventoryReserved: boolean;
  shippingLabel?: string;
  orderStatus: "pending" | "processing" | "completed";
}

const engine = new DagEngine<OrderContext>({
  logger: {
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
  },
});

engine
  .addNode({
    id: "validate-order",
    execute: async (ctx) => {
      return { orderStatus: "processing" as const };
    },
  })
  .addNode({
    id: "process-payment",
    dependsOn: ["validate-order"],
    config: { maxRetries: 3, timeoutMs: 30000 },
    shouldRun: async (ctx) => {
      // Gate: blocks dependents if false
      return ctx.orderStatus === "processing";
    },
    validate: async (ctx) => {
      // Validation: skips node but allows dependents
      return !!ctx.orderId;
    },
    execute: async (ctx) => {
      return { paymentId: "pay_12345" };
    },
  })
  .addNode({
    id: "reserve-inventory",
    dependsOn: ["validate-order"],
    validate: async (ctx) => {
      return ctx.orderStatus === "processing";
    },
    execute: async (ctx) => {
      return { inventoryReserved: true };
    },
  })
  .addNode({
    id: "create-shipping-label",
    dependsOn: ["process-payment", "reserve-inventory"],
    shouldRun: async (ctx) => {
      return !!ctx.paymentId && ctx.inventoryReserved === true;
    },
    execute: async (ctx) => {
      return { shippingLabel: "LABEL_67890" };
    },
  })
  .addNode({
    id: "complete-order",
    dependsOn: ["create-shipping-label"],
    validate: async (ctx) => {
      return !!ctx.shippingLabel;
    },
    execute: async (ctx) => {
      return { orderStatus: "completed" as const };
    },
  });
engine
  .execute({
    orderId: "ORD_001",
    inventoryReserved: false,
    orderStatus: "pending",
  })
  .then((result) => {
    if (result.success) {
      console.log("Success:", result.context);
      console.log("Metrics:", result.metrics);
    }
  })
  .catch((error) => {
    console.error("Error:", error);
  })
  .finally(() => {
    console.log("Execution completed");
  });
