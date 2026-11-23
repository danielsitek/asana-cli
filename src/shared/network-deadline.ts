import { AsyncLocalStorage } from "node:async_hooks";

// Gateways share the invocation's signal, including calls made by staged workflows.
const deadline = new AsyncLocalStorage<AbortSignal>();

export const networkDeadlineSignal = (): AbortSignal | undefined =>
  deadline.getStore();

export const withNetworkDeadline = <T>(
  signal: AbortSignal,
  action: () => Promise<T>,
): Promise<T> => deadline.run(signal, action);
