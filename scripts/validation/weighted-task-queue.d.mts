export interface WeightedTask {
  label: string;
  resourceCost?: number;
}

export function runWeightedTaskQueue<T extends WeightedTask>(
  tasks: T[],
  options: {
    budget: number;
    run: (task: T) => void | Promise<void>;
    onFailure?: (error: unknown) => void;
  },
): Promise<void>;
