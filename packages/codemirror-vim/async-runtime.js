import { validateResult } from "./result-budget.js";
// The upstream engine shares macros/registers between views. Serialize suspended
// commands across those views, but keep normal editing entirely synchronous.
let running = null;
const queue = [];
import { reserveRegexWorker } from "./worker-budget.js";
const MAX_TEXT = 8_388_608;
export const isPromise = (value) => value && typeof value.then === "function";
const cancelled = () =>
  new Error("Vim command cancelled because its editor changed.");
export class RegexChannel {
  constructor(cm, timeout = 10_000) {
    this.timeout = timeout;
    this.cm = cm;
    this.changes = [];
    this.worker = null;
    this.pending = null;
  }
  changed(update) {
    if (!this.doc || this.doc !== update.startState.doc) {
      this.doc = null;
      this.changes = [];
      return;
    }
    const changes = [];
    update.changes.iterChanges((from, to, _b, _e, text) =>
      changes.push({ from, to, insert: text.toString() }),
    );
    this.changes.push(changes);
    this.doc = update.state.doc;
  }
  request(request) {
    if (this.pending) throw Error("A Vim regex operation is already pending.");
    const doc = this.cm.cm6.state.doc;
    if (doc.length > MAX_TEXT || request.source.length > 4096)
      throw Error("Vim regex input exceeds its document or pattern limit.");
    if (!this.worker) {
      this.releaseWorker = reserveRegexWorker();
      try {
        this.worker = new Worker(
          new URL("./regex-worker.js", import.meta.url),
          { type: "module" },
        );
      } catch (error) {
        this.releaseWorker();
        this.releaseWorker = null;
        throw error;
      }
    }
    if (this.doc !== doc) {
      request.text = doc.toString();
      this.doc = doc;
      this.changes = [];
    } else if (this.changes.length) {
      request.changes = this.changes;
      this.changes = [];
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + this.timeout;
      const finish = (error, value) => {
        if (!this.pending) return;
        clearTimeout(timer);
        this.pending = null;
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        if (error) {
          this.close();
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(
        () =>
          finish(Error("Vim regex timed out. Refine the pattern and retry.")),
        this.timeout,
      );
      this.pending = (error) => finish(error);
      worker.onmessage = ({ data }) => {
        if (performance.now() >= deadline)
          return finish(
            Error("Vim regex timed out. Refine the pattern and retry."),
          );
        if (this.cm.cm6.state.doc !== doc) return finish(cancelled());
        if (data?.error) return finish(Error(data.error));
        if (
          !data ||
          data.value === undefined ||
          !Object.prototype.hasOwnProperty.call(data, "value")
        )
          return finish(Error("Invalid Vim worker response."));
        try {
          finish(null, validateResult(request, data.value, doc.length));
        } catch (error) {
          finish(error);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        finish(Error("Vim regex worker failed. Retry the command."));
      };
      worker.onmessageerror = () =>
        finish(Error("Unreadable Vim regex result."));
      try {
        worker.postMessage(request);
      } catch (error) {
        finish(error);
      }
    });
  }
  close() {
    if (this.pending) {
      this.pending(cancelled());
      return;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.releaseWorker?.();
      this.releaseWorker = null;
    }
    this.doc = null;
    this.changes = [];
  }
}
function next() {
  if (running) return;
  const entry = queue.shift();
  if (!entry) return;
  if (entry.generation !== entry.cm.vimGeneration || entry.cm.vimDisposed) {
    entry.reject(cancelled());
    next();
    return;
  }
  try {
    const value = execute(entry.cm, () => entry.fn(true), entry.preview);
    Promise.resolve(value).then(entry.resolve, entry.reject);
  } catch (error) {
    entry.reject(error);
    next();
  }
}
function execute(cm, fn, preview = false) {
  if (cm.vimDisposed) throw cancelled();
  const ticket = {
    cm,
    generation: cm.vimGeneration,
    readOnly: cm.cm6.state.readOnly,
    editable: cm.vimEditable?.(),
    channel: null,
    preview,
    deadline: performance.now() + 10_000,
  };
  running = ticket;
  let finished = false;
  let timer;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    ticket.channel?.close();
    if (running === ticket) running = null;
    if (error) cm.vimFailed?.(error, preview);
    next();
  };
  try {
    const value = continueVim(cm, ticket, fn);
    if (isPromise(value)) {
      return new Promise((resolve, reject) => {
        ticket.cancel = (error) => {
          if (finished) return;
          finish(error);
          reject(error);
        };
        timer = setTimeout(() => ticket.cancel(
          Error("Vim command timed out. Refine the search and retry."),
        ), Math.max(0, ticket.deadline - performance.now()));
        Promise.resolve(value).then(
          (result) => { if (!finished) { finish(); resolve(result); } },
          (error) => { if (!finished) { finish(error); reject(error); } },
        );
        if (cm.vimDisposed || ticket.generation !== cm.vimGeneration)
          ticket.cancel(cancelled());
      });
    }
    finish();
    return value;
  } catch (error) {
    finish(error);
    throw error;
  }
}
export function input(cm, fn, preview = false) {
  if (cm.vimExecuting) return fn();
  if (!running) return execute(cm, fn, preview);
  if (queue.length >= 256) {
    invalidate(cm);
    throw Error("Vim input queue is full. Pending commands were cancelled.");
  }
  return new Promise((resolve, reject) =>
    queue.push({
      cm,
      fn,
      resolve,
      reject,
      generation: cm.vimGeneration,
      preview,
    }),
  );
}
export function ticket(cm) {
  return running?.cm === cm ? running : null;
}
export function check(cm, owner) {
  if (owner && performance.now() >= owner.deadline)
    throw Error("Vim command timed out. Refine the search and retry.");
  if (
    cm.vimDisposed ||
    (owner &&
      (running !== owner ||
        owner.generation !== cm.vimGeneration ||
        owner.readOnly !== cm.cm6.state.readOnly ||
        owner.editable !== cm.vimEditable?.()))
  )
    throw cancelled();
}
export function continueVim(cm, owner, fn) {
  check(cm, owner);
  const previous = cm.vimExecuting;
  cm.vimExecuting = true;
  try {
    return cm.operation(fn);
  } finally {
    cm.vimExecuting = previous;
  }
}
export function request(cm, data) {
  const owner = ticket(cm);
  check(cm, owner);
  if (!owner) throw Error("Vim search has no owning command.");
  owner.channel ??= new RegexChannel(cm);
  return owner.channel.request(data).then((value) => {
    check(cm, owner);
    if (
      data.kind === "cursor" &&
      value &&
      (owner.matches = (owner.matches || 0) + 1) > 10000
    )
      throw Error(
        "Vim command exceeds 10,000 search matches. Narrow the range.",
      );
    return value;
  });
}
export function changed(cm, update) {
  ticket(cm)?.channel?.changed(update);
}
export function invalidate(cm) {
  cm.vimGeneration = (cm.vimGeneration || 0) + 1;
  const owner = ticket(cm);
  for (let i = queue.length - 1; i >= 0; i--)
    if (queue[i].cm === cm) queue.splice(i, 1)[0].reject(cancelled());
  // Reset transient shared Vim state before admitting the next editor. Late
  // resumable continuations still check their retired ticket and cannot reset
  // the new owner's state a second time.
  if (owner?.cancel) owner.cancel(cancelled());
  else owner?.channel?.close();
}
