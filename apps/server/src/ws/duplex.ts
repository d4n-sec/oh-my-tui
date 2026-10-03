import { Duplex } from "node:stream";
import { WebSocket } from "ws";

/**
 * Adapt an ordered binary WebSocket into a Node duplex stream. Used on both ends
 * of the relay: the Server hands the stream to ssh2 as its `sock`, and the Agent
 * pipes the stream to its local sshd TCP socket.
 */
export function wsToDuplex(ws: WebSocket): Duplex {
  return WebSocket.createWebSocketStream(ws);
}
