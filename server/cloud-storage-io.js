/**
 * OneDrive File Provider returns EDEADLK (errno -11) when CloudStorage
 * reads overlap. Keep those reads in one queue per process.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sep } from "node:path";

const ioContext = new AsyncLocalStorage();

/** @type {Promise<void>} */
let chain = Promise.resolve();

export function isCloudStoragePath(path) {
  return String(path || "").includes(`${sep}Library${sep}CloudStorage${sep}`);
}

/** OneDrive File Provider sometimes returns EDEADLK (errno 11 / -11). */
export function isTransientCloudError(err) {
  if (!err || err instanceof SyntaxError) return false;
  if (err.errno === -11 || err.errno === 11) return true;
  const code = String(err.code || "");
  return (
    code === "EAGAIN" ||
    code === "EBUSY" ||
    code === "EDEADLK" ||
    code === "Unknown system error -11"
  );
}

/**
 * Run `fn` only after earlier CloudStorage work finishes.
 * Nested calls in the same async turn run inline so a tree walk can
 * hold the queue without deadlocking on itself.
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function runCloudStorageIo(fn) {
  if (ioContext.getStore()?.inCloudIo) return Promise.resolve().then(fn);
  const task = chain.then(() => ioContext.run({ inCloudIo: true }, fn));
  chain = task.then(
    () => {},
    () => {}
  );
  return task;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a File Provider deadlock, and queue the attempts when `path`
 * is under CloudStorage. Local paths run immediately.
 * @template T
 * @param {string} path
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withCloudRetry(path, fn, { attempts = 4 } = {}) {
  const run = async () => {
    const n = Math.max(1, attempts);
    let last;
    for (let i = 0; i < n; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (!isTransientCloudError(err) || i === n - 1) throw err;
        await delay(40 * (i + 1));
      }
    }
    throw last;
  };
  if (isCloudStoragePath(path)) return runCloudStorageIo(run);
  return run();
}
