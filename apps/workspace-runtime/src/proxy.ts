import type { IncomingHttpHeaders } from "node:http";

export function buildWorkspaceProxyHeaders(input: {
	incoming: IncomingHttpHeaders;
	port: number;
	authorization?: string | undefined;
}) {
	const forwarded = Object.fromEntries(
		Object.entries(input.incoming).filter(
			([name, value]) => name !== "authorization" && value !== undefined,
		),
	);
	return {
		...forwarded,
		host: `127.0.0.1:${input.port}`,
		...(input.authorization ? { authorization: input.authorization } : {}),
	};
}
