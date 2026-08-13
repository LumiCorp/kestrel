export function runWeightedTaskQueue(
  tasks,
  { budget, run, onFailure = () => {} },
) {
  const resourceBudget = budget;
  if (!Number.isInteger(resourceBudget) || resourceBudget < 1) {
    throw new Error(
      `task queue budget must be a positive integer; received ${budget}`,
    );
  }

  const pending = tasks.map((item) => {
    const resourceCost = item.resourceCost ?? 1;
    if (!Number.isInteger(resourceCost) || resourceCost < 1) {
      throw new Error(
        `task '${item.label}' resource cost must be a positive integer`,
      );
    }
    if (resourceCost > resourceBudget) {
      throw new Error(
        `task '${item.label}' resource cost ${resourceCost} exceeds budget ${resourceBudget}`,
      );
    }
    return { item, resourceCost };
  });
  if (pending.length === 0) return Promise.resolve();

  let running = 0;
  let runningCost = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const launch = () => {
      if (settled) return;
      if (pending.length === 0 && running === 0) {
        settled = true;
        resolve();
        return;
      }

      for (let index = 0; index < pending.length; ) {
        const candidate = pending[index];
        if (runningCost + candidate.resourceCost > resourceBudget) {
          index += 1;
          continue;
        }

        pending.splice(index, 1);
        running += 1;
        runningCost += candidate.resourceCost;
        Promise.resolve()
          .then(() => run(candidate.item))
          .then(
            () => {
              running -= 1;
              runningCost -= candidate.resourceCost;
              launch();
            },
            (error) => {
              if (settled) return;
              settled = true;
              try {
                onFailure(error);
              } catch {}
              reject(error);
            },
          );
      }
    };

    launch();
  });
}
