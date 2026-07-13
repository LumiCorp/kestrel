import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceProxyHeaders } from "../src/proxy.js";

test("application proxy strips the Environment ticket instead of forwarding an undefined header", () => {
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

test("runner proxy replaces the Environment ticket with its internal token", () => {
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
