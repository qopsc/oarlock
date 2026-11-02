import { expect, it } from "vitest";
import { captureDropOwner } from "./dropOwnership";

function setup() {
  const session = {
    generation: 1, pty: {}, input: {}, shellExited: false, disposed: false,
    inputRevision: 0, focusRevision: 0, cwdRevision: 0,
  };
  const controller = new AbortController();
  let current: typeof session | undefined = session;
  const active = captureDropOwner(session, () => current, () => true, controller.signal, () => true);
  return { session, controller, active, drop: () => { current = undefined; } };
}

it("stays active when keys are typed, the pane is focused or the folder changes", () => {
  const { session, active } = setup();
  session.inputRevision++;
  session.focusRevision++;
  session.cwdRevision++;
  expect(active()).toBe(true);
});

it.each([
  ["a restart", (s: ReturnType<typeof setup>) => { s.session.generation++; }],
  ["a new pty", (s: ReturnType<typeof setup>) => { s.session.pty = {}; }],
  ["a new input controller", (s: ReturnType<typeof setup>) => { s.session.input = {}; }],
  ["shell exit", (s: ReturnType<typeof setup>) => { s.session.shellExited = true; }],
  ["disposal", (s: ReturnType<typeof setup>) => { s.session.disposed = true; }],
  ["an aborted lifetime", (s: ReturnType<typeof setup>) => { s.controller.abort(); }],
  ["a replaced session", (s: ReturnType<typeof setup>) => { s.drop(); }],
])("is cancelled by %s", (_name, change) => {
  const s = setup();
  change(s);
  expect(s.active()).toBe(false);
});
