/**
 * A coroutine keeps the upstream synchronous fast path. It suspends only when
 * an adapter operation actually returns a promise. Every continuation runs in
 * a fresh editor operation and checks the command's ownership before resuming.
 */
export function resumeVim(cm, iterator) {
  const ticket = cm?.vimTicket?.();
  function step(value, rejected = false, resumed = false) {
    cm?.vimCheck?.(ticket);
    const advance = () => {
      if (cm?.curOp) cm.curOp.isVimOp = true;
      let result = rejected ? iterator.throw(value) : iterator.next(value);
      while (!result.done) {
        if (result.value && typeof result.value.then === "function") {
          return result.value.then(
            (value) => step(value, false, true),
            (error) => step(error, true, true),
          );
        }
        result = iterator.next(result.value);
      }
      return result.value;
    };
    return resumed && cm?.vimContinue
      ? cm.vimContinue(ticket, advance)
      : resumed && cm?.operation
        ? cm.operation(advance)
        : advance();
  }
  return step();
}
