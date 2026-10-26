/**
 * Dedicated worker fallback, used only when SharedWorker is unavailable.
 *
 * It owns the database for a single tab, so a second tab cannot open the pool —
 * the client surfaces that as an actionable message rather than a raw DOM error.
 */

import { describeDbError, handleRequest } from './engine.js';
import type { DbRequest, DbResponse } from './protocol.js';

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent) => {
  const request = event.data as DbRequest;
  if (request === null || typeof request !== 'object' || typeof request.id !== 'number') return;

  void (async () => {
    let response: DbResponse;
    try {
      response = await handleRequest(request);
    } catch (error) {
      response = { id: request.id, ok: false, error: describeDbError(error) };
    }
    scope.postMessage(response);
  })();
};