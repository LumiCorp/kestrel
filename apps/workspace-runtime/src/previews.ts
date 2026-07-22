import { connect } from "node:net";

export function isPortListening(port: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
