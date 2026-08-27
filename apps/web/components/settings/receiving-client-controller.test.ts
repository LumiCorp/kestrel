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

  assert.equal(state.busy, true, "busy remains set while the winning refresh is pending");
  assert.deepEqual(state.domains, [readyDomain("newer-domain")]);

  newerRefresh.resolve(jsonResponse({ connection: connection("recovered") }));
  await newer;
  olderCheck.resolve(jsonResponse({ error: "Older key was revoked." }, 401));
  await older;

  assert.equal(state.connection?.readiness, "recovered");
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
  newerRefresh.resolve(jsonResponse({ connection: connection("not_ready") }));
  await newer;

  olderCheck.resolve(jsonResponse({ domains: [readyDomain("stale-domain")] }));
  await older;

  assert.equal(state.connection?.readiness, "not_ready");
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
  newerLoad.resolve(jsonResponse({ connection: connection("current_load") }));
  await load;
  olderSave.resolve(jsonResponse({ connection: connection("stale_save") }));
  await save;

  assert.equal(state.connection?.readiness, "current_load");
  assert.equal(state.error, undefined);
  assert.deepEqual(state.busyTransitions, [true, false]);
});

test("a winning save clears the write-only form but stays busy through reconciliation", async () => {
  const saveResponse = deferredResponse();
  const refresh = deferredResponse();
  const { controller, state } = fixture([saveResponse, refresh]);
  state.apiKey = "replacement-key";
  state.domainId = "ready-domain";

  const save = controller.save(state.apiKey, state.domainId);
  saveResponse.resolve(jsonResponse({ connection: connection("saving") }));
  await settled();

  assert.equal(state.apiKey, "");
  assert.equal(state.domainId, "");
  assert.equal(state.busy, true);
  assert.deepEqual(state.successes, ["Inbound receiving configuration saved."]);

  refresh.resolve(jsonResponse({ connection: connection("saved") }));
  await save;

  assert.equal(state.connection?.readiness, "saved");
  assert.deepEqual(state.busyTransitions, [true, false]);
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

function fixture(requests: DeferredResponse[]) {
  const state: PresentationState = {
    apiKey: "",
    busy: false,
    busyTransitions: [],
    connection: undefined,
    domainId: "",
    domains: [],
    error: undefined,
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
      setApiKey: (value) => write(() => {
        state.apiKey = value;
      }),
      setBusy: (value) => write(() => {
        state.busy = value;
        state.busyTransitions.push(value);
      }),
      setConnection: (value) => write(() => {
        state.connection = value;
      }),
      setDomainId: (value) => write(() => {
        state.domainId = value;
      }),
      setDomains: (value) => write(() => {
        state.domains = value;
      }),
      setError: (value) => write(() => {
        state.error = value;
      }),
      showInfo: () => write(() => {}),
      showSuccess: (message) => write(() => {
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

function connection(readiness: string): ReceivingConnection {
  return {
    configured: true,
    credentialStatus: "full_access",
    credentialValidatedAt: "2026-08-27T12:00:00.000Z",
    domainCheckedAt: "2026-08-27T12:00:00.000Z",
    inboundEnabled: false,
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

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
