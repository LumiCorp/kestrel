import type { DesktopBridge } from "../../src/contracts";

declare global {
  interface Window {
    kestrelDesktop: DesktopBridge;
  }
}

export {};
