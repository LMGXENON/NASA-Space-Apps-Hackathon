/**
 * Main-thread client for the Rover Agent worker. Latest-wins: stale
 * responses are dropped (PRD Part D concurrency rules).
 *
 * Worker failures must never leave callers hanging: `onerror` /
 * `onmessageerror` reject everything in flight so the UI can show a message.
 */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function failAll(reason: string): void {
  for (const [, p] of pending) p.reject(new Error(reason));
  pending.clear();
}

function w(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/rover.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, result, error } = e.data as { id: number; ok: boolean; result?: unknown; error?: string };
      const p = pending.get(id);
      if (!p) return; // stale id
      pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    worker.onerror = (e: ErrorEvent) => {
      failAll(`rover worker failed: ${e.message || "script error"}`);
    };
    worker.onmessageerror = () => {
      failAll("rover worker returned an unreadable message");
    };
  }
  return worker;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const roverApi = {
  loadTerrain: (hf: any, horizon: ArrayBuffer, nAz: number, hPx: number): Promise<void> =>
    call("loadTerrain", { hf, horizon, nAz, hPx }) as Promise<void>,
  simulate: (req: any): Promise<any> => call("simulate", req),
  ribbon: (req: any): Promise<any> => call("ribbon", req),
  dutyMap: (req: any): Promise<any> => call("dutyMap", req),
  rayHit: (req: any): Promise<any> => call("rayHit", req),
  nextEvent: (req: any): Promise<any> => call("nextEvent", req),
  autoPlan: (req: any): Promise<any> => call("autoPlan", req),
  validate: (req: any): Promise<any> => call("validate", req),
};

function call(fn: string, payload: unknown): Promise<unknown> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      // `id` must travel with the request: the worker echoes it back and the
      // response is matched against `pending` by that key.
      w().postMessage({ id, fn, payload });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}
