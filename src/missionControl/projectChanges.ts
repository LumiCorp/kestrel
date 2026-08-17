import type { MissionControlProjectStateRecord } from "./projectAuthority.js";

export type MissionControlProjectChangeListener = (
  project: MissionControlProjectStateRecord,
) => void;

export class MissionControlProjectChangePublisher {
  private readonly listeners = new Set<MissionControlProjectChangeListener>();

  publish = (project: MissionControlProjectStateRecord): void => {
    for (const listener of this.listeners) {
      try {
        listener(project);
      } catch {
        // Observers cannot make a committed authority mutation fail.
      }
    }
  };

  subscribe(listener: MissionControlProjectChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }
}
