import assert from "node:assert/strict";
import {
	buildWorkspaceProxyHeaders,
	isRunnerProxyPath,
} from "../src/proxy.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.hermetic", "application proxy strips the Environment ticket instead of forwarding an undefined header", () => {
	const headers = buildWorkspaceProxyHeaders({
		incoming: {
			authorization: "Bearer environment-ticket",
			accept: "text/html",
		},
		port: 3200,
	});

	assert.deepEqual(headers, {
		accept: "text/html",
		host: "127.0.0.1:3200",
	});
});

contractTest("services.hermetic", "runner proxy replaces the Environment ticket with its internal token", () => {
	const headers = buildWorkspaceProxyHeaders({
		incoming: {
			authorization: "Bearer environment-ticket",
			"content-type": "application/json",
		},
		port: 43_105,
		authorization: "Bearer runner-token",
	});

	assert.deepEqual(headers, {
		authorization: "Bearer runner-token",
		"content-type": "application/json",
		host: "127.0.0.1:43105",
	});
});

contractTest("services.hermetic", "runner proxy includes filtered event subscriptions", () => {
	assert.equal(isRunnerProxyPath("/commands"), true);
	assert.equal(isRunnerProxyPath("/commands/stream"), true);
	assert.equal(isRunnerProxyPath("/events/stream"), true);
	assert.equal(isRunnerProxyPath("/events/stream/other"), false);
	assert.equal(isRunnerProxyPath("/v1/tree"), false);
});
