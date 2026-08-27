type WorkerMaintenanceInput = {
  reconcileReceivingWebhooks: () => Promise<unknown>;
  reportReceivingWebhookFailure: (error: unknown) => void;
  recoverEmailReceipts: () => Promise<unknown>;
  reportEmailReceiptFailure: (error: unknown) => void;
  recoverSchedules: () => Promise<unknown>;
  reconcileTurns: () => Promise<unknown>;
  drainMobilePush: () => Promise<unknown>;
  reportMobilePushFailure: (error: unknown) => void;
};

/** Keeps independent durable recovery lanes progressing after an isolated fault. */
export async function runTurnWorkerMaintenance(input: WorkerMaintenanceInput) {
  await input
    .reconcileReceivingWebhooks()
    .catch(input.reportReceivingWebhookFailure);
  await input.recoverEmailReceipts().catch(input.reportEmailReceiptFailure);
  await input.recoverSchedules();
  await input.reconcileTurns();
  await input.drainMobilePush().catch(input.reportMobilePushFailure);
}
