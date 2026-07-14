const SERVER_ONLY_MODULE_URL = "data:text/javascript,export%20{}";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      shortCircuit: true,
      url: SERVER_ONLY_MODULE_URL,
    };
  }
  return nextResolve(specifier, context);
}
