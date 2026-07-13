import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { KestrelClient } from "@kestrel-agents/sdk/runner";
import {
	ENVIRONMENT_ROUTER_AUDIENCE,
	signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";

const workspaceUrl = new URL(
	process.env.KESTREL_LOCAL_CANARY_WORKSPACE_URL ?? "http://127.0.0.1:43114",
);
const routerUrl = new URL(
	process.env.KESTREL_LOCAL_CANARY_ROUTER_URL ?? "http://127.0.0.1:43116",
);
const privateKeyPath = required("KESTREL_LOCAL_CANARY_PRIVATE_KEY_PATH");
const privateKey = await readFile(privateKeyPath, "utf8");
const identity = {
	organizationId: "org-canary",
	environmentId: "environment-canary",
	workspaceId: "workspace-canary",
	threadId: "thread-canary",
	actorId: "actor-canary",
	agentId: "kestrel-one",
	flyAppName: "app-canary",
	flyMachineId: "machine-canary",
};
const capabilities = [
	"profile.read",
	"run.stream",
	"run.cancel",
	"session.read",
	"events.subscribe",
	"workspace.files.read",
	"workspace.files.write",
	"workspace.terminal.exec",
	"workspace.apps.read",
	"workspace.apps.write",
	"workspace.backups.export",
	"workspace.backups.restore",
	"workspace.promotions.read",
	"workspace.promotions.apply",
	"knowledge.search",
];

await Promise.all([
	waitForHealth(new URL("/health", workspaceUrl)),
	waitForHealth(new URL("/health", routerUrl)),
]);
const token = signTicket();
const authorization = { authorization: `Bearer ${token}` };

if (process.env.KESTREL_LOCAL_CANARY_VERIFY_RESTORED === "true") {
	const restoredFile = await expectOk(
		workspaceRequest("/v1/files?path=canary.txt"),
	);
	assert.equal(await restoredFile.text(), "human-v2\n");
	const applications = await expectOk(workspaceRequest("/v1/apps"));
	const restoredApplication = (
		(await applications.json()) as {
			applications: Array<{ id: string; name: string; status: string }>;
		}
	).applications.find(
		(application) => application.name === "Canary application",
	);
	assert.ok(restoredApplication);
	assert.equal(restoredApplication.status, "running");
	const proxy = await waitForWorkspaceResponse(
		`/v1/apps/${restoredApplication.id}/proxy/`,
	);
	assert.equal(await proxy.text(), "application-canary");
	const promotions = await expectOk(workspaceRequest("/v1/promotions"));
	assert.ok(
		Array.isArray(
			((await promotions.json()) as { promotions?: unknown }).promotions,
		),
	);
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			restoredFilesystem: true,
			restoredApplicationId: restoredApplication.id,
			restoredApplicationProcess: true,
			restoredCandidateSurface: true,
		})}\n`,
	);
	process.exit(0);
}

const runnerClient = new KestrelClient({
	baseUrl: workspaceUrl.toString(),
	authToken: token,
});
try {
	const profile = await runnerClient.getProfile("kestrel-one", {
		actor: {
			actorId: identity.actorId,
			actorType: "end_user",
			tenantId: identity.organizationId,
		},
		tenantId: identity.organizationId,
	});
	assert.equal(profile.id, "kestrel-one");
} finally {
	await runnerClient.close();
}
const promotionList = await expectOk(workspaceRequest("/v1/promotions"));
assert.ok(
	Array.isArray(
		((await promotionList.json()) as { promotions?: unknown }).promotions,
	),
);

const routerDecision = await fetch(new URL("/v1/tree", routerUrl), {
	headers: authorization,
});
assert.equal(routerDecision.status, 204);
assert.equal(
	routerDecision.headers.get("fly-replay"),
	"app=app-canary;instance=machine-canary",
);
assert.equal(
	routerDecision.headers.get("x-kestrel-environment-id"),
	identity.environmentId,
);
assert.equal(
	routerDecision.headers.get("x-kestrel-workspace-id"),
	identity.workspaceId,
);

const crossTenantRouter = await fetch(new URL("/commands", routerUrl), {
	method: "POST",
	headers: { ...authorization, "content-type": "application/json" },
	body: JSON.stringify({
		type: "run.start",
		metadata: { tenantId: "org-other" },
		payload: { turn: { sessionId: identity.threadId } },
	}),
});
assert.equal(crossTenantRouter.status, 403);
assert.equal(
	((await crossTenantRouter.json()) as { error: { code: string } }).error.code,
	"ENVIRONMENT_TENANT_MISMATCH",
);

const crossTenantWorkspace = await workspaceRequest("/v1/tree", {
	token: signTicket({ organizationId: "org-other" }),
});
assert.equal(crossTenantWorkspace.status, 403);
assert.equal(
	((await crossTenantWorkspace.json()) as { error: { code: string } }).error
		.code,
	"WORKSPACE_SCOPE_MISMATCH",
);

await expectOk(
	workspaceRequest("/v1/terminal/exec", {
		method: "POST",
		json: { command: "printf 'agent-v1\\n' > canary.txt" },
	}),
);
const initialFile = await expectOk(
	workspaceRequest("/v1/files?path=canary.txt"),
);
const initialRevision = initialFile.headers.get("etag");
assert.ok(initialRevision);
assert.equal(await initialFile.text(), "agent-v1\n");

const humanSave = await expectOk(
	workspaceRequest("/v1/files?path=canary.txt", {
		method: "PUT",
		headers: { "if-match": initialRevision },
		body: "human-v2\n",
	}),
);
const humanRevision = humanSave.headers.get("etag");
assert.ok(humanRevision);
const staleSave = await workspaceRequest("/v1/files?path=canary.txt", {
	method: "PUT",
	headers: { "if-match": initialRevision },
	body: "stale-human-write\n",
});
assert.equal(staleSave.status, 409);
assert.equal(
	((await staleSave.json()) as { error: { code: string } }).error.code,
	"WORKSPACE_FILE_REVISION_CONFLICT",
);

const exportedBackup = await expectOk(workspaceRequest("/v1/backups/export"));
const archive = Buffer.from(await exportedBackup.arrayBuffer());
const checksumSha256 = createHash("sha256").update(archive).digest("hex");
await expectOk(
	workspaceRequest("/v1/terminal/exec", {
		method: "POST",
		json: { command: "printf 'after-backup\\n' > canary.txt" },
	}),
);
const importCreated = await expectOk(
	workspaceRequest("/v1/backups/imports", {
		method: "POST",
		json: { checksumSha256 },
	}),
);
const importId = ((await importCreated.json()) as { id: string }).id;
for (let offset = 0, index = 0; offset < archive.length; index += 1) {
	const end = Math.min(offset + 512 * 1024, archive.length);
	await expectOk(
		workspaceRequest(`/v1/backups/imports/${importId}/chunks/${index}`, {
			method: "PUT",
			body: archive.subarray(offset, end),
		}),
	);
	offset = end;
}
await expectOk(
	workspaceRequest(`/v1/backups/imports/${importId}/complete`, {
		method: "POST",
	}),
);
const restoredFile = await expectOk(
	workspaceRequest("/v1/files?path=canary.txt"),
);
assert.equal(await restoredFile.text(), "human-v2\n");

const terminalCreated = await expectOk(
	workspaceRequest("/v1/terminal/sessions", {
		method: "POST",
		json: { cwd: "" },
	}),
);
const terminalId = ((await terminalCreated.json()) as { id: string }).id;
await expectOk(
	workspaceRequest(`/v1/terminal/sessions/${terminalId}/input`, {
		method: "POST",
		body: "echo pty-canary\n",
	}),
);
await new Promise((resolve) => setTimeout(resolve, 100));
const terminalOutput = await expectOk(
	workspaceRequest(`/v1/terminal/sessions/${terminalId}/output?cursor=0`),
);
assert.match(JSON.stringify(await terminalOutput.json()), /pty-canary/u);
await expectOk(
	workspaceRequest(`/v1/terminal/sessions/${terminalId}`, {
		method: "DELETE",
	}),
);

const applicationCreated = await expectOk(
	workspaceRequest("/v1/apps", {
		method: "POST",
		json: {
			name: "Canary application",
			command:
				"node -e \"require('node:http').createServer((_request,response)=>response.end('application-canary')).listen(Number(process.env.PORT))\"",
			workingDirectory: "",
			port: 3200,
		},
	}),
);
const application = (
	(await applicationCreated.json()) as {
		application: { id: string; status: string };
	}
).application;
assert.equal(application.status, "running");
await new Promise((resolve) => setTimeout(resolve, 150));
const applicationProxy = await waitForWorkspaceResponse(
	`/v1/apps/${application.id}/proxy/`,
);
assert.equal(await applicationProxy.text(), "application-canary");

const tree = await expectOk(workspaceRequest("/v1/tree"));
assert.match(JSON.stringify(await tree.json()), /canary\.txt/u);

process.stdout.write(
	`${JSON.stringify({
		ok: true,
		runner: true,
		candidateSurface: true,
		router: true,
		tenantIsolation: true,
		revisionConflict: true,
		backupRestore: true,
		pty: true,
		applicationId: application.id,
		applicationProxy: true,
		humanRevision,
	})}\n`,
);

function signTicket(overrides: Partial<typeof identity> = {}) {
	const now = Math.floor(Date.now() / 1000);
	return signEnvironmentExecutionTicket({
		privateKey,
		ticket: {
			version: 1,
			audience: ENVIRONMENT_ROUTER_AUDIENCE,
			...identity,
			...overrides,
			runId: randomUUID(),
			capabilities,
			issuedAt: now,
			expiresAt: now + 300,
			nonce: randomUUID(),
		},
	});
}

function workspaceRequest(
	pathname: string,
	options: {
		token?: string;
		method?: string;
		headers?: Record<string, string>;
		body?: BodyInit;
		json?: unknown;
	} = {},
) {
	return fetch(new URL(pathname, workspaceUrl), {
		method: options.method,
		headers: {
			authorization: `Bearer ${options.token ?? token}`,
			...(options.json === undefined
				? {}
				: { "content-type": "application/json" }),
			...options.headers,
		},
		body:
			options.json === undefined ? options.body : JSON.stringify(options.json),
	});
}

async function expectOk(response: Promise<Response>) {
	const resolved = await response;
	if (!resolved.ok) {
		throw new Error(
			`Canary request failed (${resolved.status}): ${await resolved.text()}`,
		);
	}
	return resolved;
}

async function waitForWorkspaceResponse(pathname: string) {
	const deadline = Date.now() + 5000;
	let lastResponse: Response | undefined;
	while (Date.now() < deadline) {
		lastResponse = await workspaceRequest(pathname);
		if (lastResponse.ok) return lastResponse;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`Canary application did not become ready (${lastResponse?.status ?? "no response"}).`,
	);
}

async function waitForHealth(url: URL) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Canary service did not become healthy: ${url.origin}`);
}

function required(name: string) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
}
