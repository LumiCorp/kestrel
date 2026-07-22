import {
	createRuntimeFailure,
	RuntimeFailure,
} from "../../src/runtime/RuntimeFailure.js";
import type {
	SharedToolContext,
	SharedToolDefinition,
	SharedToolModule,
} from "../contracts.js";
import { parseObjectInput } from "../helpers.js";

type VercelToolOptions = {
	name: string;
	displayName: string;
	description: string;
	capability: "projects.read" | "deployments.read" | "operations.read";
	path: "projects" | "deployments" | "deployment-events";
	inputSchema: Record<string, unknown>;
};

function createVercelTool(options: VercelToolOptions): SharedToolModule {
	const definition: SharedToolDefinition = {
		name: options.name,
		description: options.description,
		inputSchema: options.inputSchema,
		capability: {
			freshnessClass: "live",
			latencyClass: "medium",
			costClass: "free",
			executionClass: "read_only",
			capabilityClasses: ["vercel.delivery", "network.call"],
			approvalCapabilities: ["network.call"],
			suitability: {
				supportsAttribution: true,
				supportsAggregation: true,
				typicalFailureModes: [
					"vercel_not_connected",
					"vercel_access_denied",
					"vercel_unavailable",
				],
			},
		},
		presentation: {
			displayName: options.displayName,
			aliases: [options.displayName.toLowerCase()],
			keywords: ["vercel", "deployment", options.capability],
			provider: "kestrel-one",
			toolFamily: "delivery",
		},
	};
	return {
		definition,
		createHandler(context) {
			return async (input: unknown) =>
				invokeVercel(context, {
					body: parseObjectInput(options.name, input),
					capability: options.capability,
					path: options.path,
					toolName: options.name,
				});
		},
	};
}

export const kestrelOneVercelListProjectsTool = createVercelTool({
	name: "kestrel_one.vercel_list_projects",
	displayName: "Vercel List Projects",
	description:
		"List projects available to the connected Vercel account or team.",
	capability: "projects.read",
	path: "projects",
	inputSchema: {
		type: "object",
		properties: {
			limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
			search: { type: "string", minLength: 1, maxLength: 256 },
		},
		additionalProperties: false,
	},
});

export const kestrelOneVercelListDeploymentsTool = createVercelTool({
	name: "kestrel_one.vercel_list_deployments",
	displayName: "Vercel List Deployments",
	description:
		"List recent Vercel deployments and their current delivery state.",
	capability: "deployments.read",
	path: "deployments",
	inputSchema: {
		type: "object",
		properties: {
			limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
			projectId: { type: "string", minLength: 1, maxLength: 256 },
			state: {
				type: "string",
				enum: [
					"BUILDING",
					"ERROR",
					"INITIALIZING",
					"QUEUED",
					"READY",
					"CANCELED",
				],
			},
			target: { type: "string", enum: ["production", "preview"] },
		},
		additionalProperties: false,
	},
});

export const kestrelOneVercelDeploymentEventsTool = createVercelTool({
	name: "kestrel_one.vercel_deployment_events",
	displayName: "Vercel Deployment Events",
	description:
		"Read bounded build and runtime events for one Vercel deployment.",
	capability: "operations.read",
	path: "deployment-events",
	inputSchema: {
		type: "object",
		properties: {
			deploymentId: { type: "string", minLength: 1, maxLength: 512 },
			limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
			direction: { type: "string", enum: ["backward", "forward"] },
			since: { type: "integer", minimum: 0 },
			until: { type: "integer", minimum: 0 },
		},
		required: ["deploymentId"],
		additionalProperties: false,
	},
});

async function invokeVercel(
	context: SharedToolContext,
	input: {
		body: Record<string, unknown>;
		capability: string;
		path: string;
		toolName: string;
	},
) {
	const appUrl = requireContextValue(
		context.kestrelOne?.appUrl,
		"KESTREL_ONE_APP_URL",
	);
	const ticket = requireContextValue(
		context.kestrelOne?.executionTicket,
		"Environment execution ticket",
	);
	const approval =
		context.kestrelOne?.appApprovalModes?.[input.toolName] === "ask"
			? "confirmed"
			: "auto";
	const url = new URL(
		`/api/runtime/apps/vercel/${encodeURIComponent(input.capability)}/${approval}/${input.path}`,
		appUrl,
	);
	const response = await (context.fetchImpl ?? fetch)(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${ticket}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(input.body),
	});
	const body: unknown = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new RuntimeFailure(
			"KESTREL_ONE_VERCEL_ACTION_FAILED",
			`Kestrel One rejected ${input.toolName} with HTTP ${response.status}.`,
			{
				subsystem: "tooling",
				toolName: input.toolName,
				status: response.status,
				classification: response.status >= 500 ? "runtime" : "policy",
				recoverable: response.status >= 500 || response.status === 429,
			},
		);
	}
	return body;
}

function requireContextValue(value: string | undefined, label: string) {
	if (!value?.trim()) {
		throw createRuntimeFailure(
			"KESTREL_ONE_VERCEL_CONTEXT_MISSING",
			`${label} is required for Kestrel One Vercel tools.`,
			{
				subsystem: "tooling",
				classification: "configuration",
				recoverable: true,
			},
		);
	}
	return value.trim();
}
