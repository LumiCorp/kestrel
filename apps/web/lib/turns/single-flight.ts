export type SingleFlightOperation = () => Promise<void>;

export function createSingleFlightOperation(operation: SingleFlightOperation) {
  let active: Promise<void> | null = null;

  return () => {
    if (active) {
      return active;
    }

    const current = operation().finally(() => {
      if (active === current) {
        active = null;
      }
    });
    active = current;
    return current;
  };
}
