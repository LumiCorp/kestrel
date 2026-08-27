import assert from "node:assert/strict";
import test from "node:test";

import {
  OrganizationReceivingController,
  type ReceivingConnection,
  type ReceivingDomain,
} from "./receiving-client-controller";

type DeferredResponse = {
  promise: Promise<Response>;
  resolve(response: Response): void;
};

type PresentationState = {
  apiKey: string;
  busy: boolean;
  busyTransitions: boolean[];
  connection: ReceivingConnection | undefined;
  domainId: string;
  domains: ReceivingDomain[];
  error: string | undefined;
  infos: string[];
  successes: string[];
  writes: number;
};

test("a delayed failed check cannot repaint a newer successful recovery", async () => {
  const olderCheck = deferredResponse();
  const newerCheck = deferredResponse();
  const newerRefresh = deferredResponse();
  const requests = [olderCheck, newerCheck, newerRefresh];
  const { controller, state } = fixture(requests);

  const older = controller.inspectDomains("older-key");
  const newer = controller.inspectDomains("newer-key");
  newerCheck.resolve(jsonResponse({ domains: [readyDomain("newer-domain")] }));
  await settled();

  assert.equal(
    state.busy,
    true,
    "busy remains set while the winning refresh is pending",
  );
  assert.deepEqual(state.domains, []);

  newerRefresh.resolve(jsonResponse({ connection: connection("active") }));
  await newer;
  olderCheck.resolve(jsonResponse({ error: "Older key was revoked." }, 401));
  await older;

  assert.equal(state.connection?.readiness, "active");
  assert.deepEqual(state.domains, [readyDomain("newer-domain")]);
  assert.equal(state.error, undefined);
  assert.deepEqual(state.busyTransitions, [true, false]);
});

test("a delayed successful check cannot clear a newer failure or replace its choices", async () => {
  const olderCheck = deferredResponse();
  const newerCheck = deferredResponse();
  const newerRefresh = deferredResponse();
  const requests = [olderCheck, newerCheck, newerRefresh];
  const { controller, state } = fixture(requests);

  const older = controller.inspectDomains("older-key");
  const newer = controller.inspectDomains("newer-key");
  newerCheck.resolve(jsonResponse({ error: "Newest key is invalid." }, 401));
  await settled();
  newerRefresh.resolve(
    jsonResponse({ connection: connection("domain_unready") }),
  );
  await newer;

  olderCheck.resolve(jsonResponse({ domains: [readyDomain("stale-domain")] }));
  await older;

  assert.equal(state.connection?.readiness, "domain_unready");
  assert.deepEqual(state.domains, []);
  assert.equal(state.error, "Newest key is invalid.");
  assert.deepEqual(state.busyTransitions, [true, false]);
});

test("a newer load supersedes a delayed save and owns the final busy transition", async () => {
  const olderSave = deferredResponse();
  const newerLoad = deferredResponse();
  const { controller, state } = fixture([olderSave, newerLoad]);

  const save = controller.save("older-key", "older-domain");
  const load = controller.load();
  newerLoad.resolve(jsonResponse({ connection: connection("staged") }));
  await load;
  olderSave.resolve(jsonResponse({ connection: connection("error") }));
  await save;

  assert.equal(state.connection?.readiness, "staged");
  assert.equal(state.error, undefined);
  assert.deepEqual(state.busyTransitions, [true, false]);
});

test("a winning save commits the cleared form only after reconciliation", async () => {
  const saveResponse = deferredResponse();
  const refresh = deferredResponse();
  const { controller, state } = fixture([saveResponse, refresh]);
  state.apiKey = "replacement-key";
  state.domainId = "ready-domain";

  const save = controller.save(state.apiKey, state.domainId);
  saveResponse.resolve(
    jsonResponse({ connection: connection("ready_inactive") }),
  );
  await settled();

  assert.equal(state.apiKey, "replacement-key");
  assert.equal(state.domainId, "ready-domain");
  assert.equal(state.busy, true);
  assert.deepEqual(state.successes, []);

  refresh.resolve(jsonResponse({ connection: connection("staged") }));
  await save;

  assert.equal(state.connection?.readiness, "staged");
  assert.equal(state.apiKey, "");
  assert.equal(state.domainId, "");
  assert.deepEqual(state.domains, []);
  assert.deepEqual(state.successes, ["Inbound receiving configuration saved."]);
  assert.deepEqual(state.busyTransitions, [true, false]);
});

test("activation reconciles the redacted hosted connection before reporting success", async () => {
  const activation = deferredResponse();
  const refresh = deferredResponse();
  const { controller, state } = fixture([activation, refresh]);

  const enabling = controller.setInboundEnabled(true);
  activation.resolve(jsonResponse({ connection: connection("active", true) }));
  await settled();
  refresh.resolve(jsonResponse({ connection: connection("active", true) }));
  await enabling;

  assert.equal(state.connection?.inboundEnabled, true);
  assert.equal(state.connection?.readiness, "active");
  assert.deepEqual(state.successes, ["Inbound receiving enabled."]);
});

test("failed disablement refreshes the ingress-closed state without claiming success", async () => {
  const disable = deferredResponse();
  const refresh = deferredResponse();
  const { controller, state } = fixture([disable, refresh]);
  state.connection = connection("active", true);

  const disabling = controller.setInboundEnabled(false);
  disable.resolve(
    jsonResponse(
      {
        error:
          "Inbound receiving remains closed while Resend disablement is retried.",
      },
      503,
    ),
  );
  await settled();
  refresh.resolve(
    jsonResponse({
      connection: {
        ...connection("error", false),
        lastErrorCode: "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED",
      },
    }),
  );
  await disabling;

  assert.equal(state.connection?.inboundEnabled, false);
  assert.equal(
    state.connection?.lastErrorCode,
    "RESEND_RECEIVING_WEBHOOK_DISABLE_FAILED",
  );
  assert.equal(
    state.error,
    "Inbound receiving remains closed while Resend disablement is retried.",
  );
  assert.deepEqual(state.successes, []);
});

test("deactivation prevents a pending operation from writing after unmount", async () => {
  const pendingCheck = deferredResponse();
  const { controller, state } = fixture([pendingCheck]);
  const pending = controller.inspectDomains("key");
  const writesBeforeUnmount = state.writes;

  controller.deactivate();
  pendingCheck.resolve(jsonResponse({ domains: [readyDomain("late-domain")] }));
  await pending;

  assert.equal(state.writes, writesBeforeUnmount);
  assert.deepEqual(state.domains, []);
  assert.equal(state.error, undefined);
});

test("a load with a missing connection preserves the prior valid presentation", async () => {
  const loadResponse = deferredResponse();
  const { controller, state } = fixture([loadResponse]);
  seedPresentation(state);

  const load = controller.load();
  loadResponse.resolve(jsonResponse({}));
  await load;

  assertPresentationPreserved(state);
  assert.equal(state.error, "Could not load inbound receiving.");
  assert.deepEqual(state.successes, []);
});

test("a domain check with a wrong-type envelope preserves the form and choices", async () => {
  const checkResponse = deferredResponse();
  const { controller, state } = fixture([checkResponse]);
  seedPresentation(state);

  const check = controller.inspectDomains(state.apiKey);
  checkResponse.resolve(jsonResponse({ domains: "not-an-array" }));
  await check;

  assertPresentationPreserved(state);
  assert.equal(state.error, "Could not inspect Resend receiving domains.");
  assert.deepEqual(state.infos, []);
  assert.deepEqual(state.successes, []);
});

test("a save with a secret-bearing unknown field cannot clear the form or report success", async () => {
  const saveResponse = deferredResponse();
  const { controller, state } = fixture([saveResponse]);
  seedPresentation(state);

  const save = controller.save(state.apiKey, state.domainId);
  saveResponse.resolve(
    jsonResponse({
      connection: {
        ...connection("ready_inactive"),
        apiKey: "re_must_not_reach_the_client",
      },
    }),
  );
  await save;

  assertPresentationPreserved(state);
  assert.equal(state.error, "Could not save inbound receiving.");
  assert.deepEqual(state.successes, []);
});

test("a domain check with malformed reconciliation preserves old domain choices", async () => {
  const checkResponse = deferredResponse();
  const reconcileResponse = deferredResponse();
  const { controller, state } = fixture([checkResponse, reconcileResponse]);
  seedPresentation(state);

  const check = controller.inspectDomains(state.apiKey);
  checkResponse.resolve(jsonResponse({ domains: [readyDomain("new-domain")] }));
  await settled();
  reconcileResponse.resolve(
    jsonResponse({
      connection: {
        ...connection("ready_inactive"),
        webhookStatus: "future_status",
      },
    }),
  );
  await check;

  assertPresentationPreserved(state);
  assert.equal(state.error, "Could not inspect Resend receiving domains.");
  assert.deepEqual(state.infos, []);
  assert.deepEqual(state.successes, []);
});

test("a save with malformed reconciliation preserves the write-only form", async () => {
  const saveResponse = deferredResponse();
  const reconcileResponse = deferredResponse();
  const { controller, state } = fixture([saveResponse, reconcileResponse]);
  seedPresentation(state);

  const save = controller.save(state.apiKey, state.domainId);
  saveResponse.resolve(
    jsonResponse({ connection: connection("ready_inactive") }),
  );
  await settled();
  reconcileResponse.resolve(
    jsonResponse({
      connection: {
        ...connection("staged"),
        credentialStatus: "future_status",
      },
    }),
  );
  await save;

  assertPresentationPreserved(state);
  assert.equal(state.error, "Could not save inbound receiving.");
  assert.deepEqual(state.infos, []);
  assert.deepEqual(state.successes, []);
  assert.deepEqual(state.busyTransitions, [true, false]);
});

function fixture(requests: DeferredResponse[]) {
  const state: PresentationState = {
    apiKey: "",
    busy: false,
    busyTransitions: [],
    connection: undefined,
    domainId: "",
    domains: [],
    error: undefined,
    infos: [],
    successes: [],
    writes: 0,
  };
  let requestIndex = 0;
  const request = () => {
    const deferred = requests[requestIndex];
    requestIndex += 1;
    if (!deferred) {
      throw new Error(`Unexpected request ${requestIndex}`);
    }
    return deferred.promise;
  };
  const write = (update: () => void) => {
    state.writes += 1;
    update();
  };
  const controller = new OrganizationReceivingController(
    {
      setApiKey: (value) =>
        write(() => {
          state.apiKey = value;
        }),
      setBusy: (value) =>
        write(() => {
          state.busy = value;
          state.busyTransitions.push(value);
        }),
      setConnection: (value) =>
        write(() => {
          state.connection = value;
        }),
      setDomainId: (value) =>
        write(() => {
          state.domainId = value;
        }),
      setDomains: (value) =>
        write(() => {
          state.domains = value;
        }),
      setError: (value) =>
        write(() => {
          state.error = value;
        }),
      showInfo: (message) =>
        write(() => {
          state.infos.push(message);
        }),
      showSuccess: (message) =>
        write(() => {
          state.successes.push(message);
        }),
    },
    request,
  );
  return { controller, state };
}

function deferredResponse(): DeferredResponse {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function readyDomain(id: string): ReceivingDomain {
  return {
    id,
    mxStatus: "verified",
    name: `${id}.example.com`,
    receiving: "enabled",
    status: "verified",
  };
}

function connection(
  readiness: ReceivingConnection["readiness"],
  inboundEnabled = false,
): ReceivingConnection {
  return {
    configured: true,
    credentialStatus: "full_access",
    credentialValidatedAt: "2026-08-27T12:00:00.000Z",
    domainCheckedAt: "2026-08-27T12:00:00.000Z",
    inboundEnabled,
    lastErrorCode: null,
    lastHealthCheckedAt: "2026-08-27T12:00:00.000Z",
    lastTestedAt: null,
    mxStatus: "verified",
    provider: "resend",
    readiness,
    receivingDomain: "inbound.example.com",
    receivingDomainStatus: "verified",
    webhookStatus: "not_staged",
  };
}

function seedPresentation(state: PresentationState): void {
  state.apiKey = "replacement-key";
  state.connection = connection("ready_inactive");
  state.domainId = "ready-domain";
  state.domains = [readyDomain("ready-domain")];
}

function assertPresentationPreserved(state: PresentationState): void {
  assert.equal(state.apiKey, "replacement-key");
  assert.deepEqual(state.connection, connection("ready_inactive"));
  assert.equal(state.domainId, "ready-domain");
  assert.deepEqual(state.domains, [readyDomain("ready-domain")]);
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
