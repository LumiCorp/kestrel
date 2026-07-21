import { AsyncLocalStorage } from "node:async_hooks";

const localCoreStoreOwnership = new AsyncLocalStorage<true>();

export function withLocalCoreDaemonStoreOwnership<T>(callback: () => T): T {
  return localCoreStoreOwnership.run(true, callback);
}

export function hasLocalCoreDaemonStoreOwnership(): boolean {
  return localCoreStoreOwnership.getStore() === true;
}
