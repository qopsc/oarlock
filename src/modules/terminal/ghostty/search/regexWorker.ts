import { compileTerminalPattern, matchLine } from "./regexEvaluation";
import {
  validateRegexBatch,
  type RegexBatch,
  type RegexMatch,
  type RegexReply,
} from "./regexProtocol";

// This module is exclusively a worker entry. Never import its evaluator into UI code.
self.onmessage = (event: MessageEvent<{ id: number; batch: RegexBatch }>) => {
  const { id, batch } = event.data;
  let reply: RegexReply;
  try {
    validateRegexBatch(batch);
    const regex = compileTerminalPattern(batch.pattern);
    if (!regex)
      throw new Error("Invalid regex or a pattern that matches empty text.");
    const matches: RegexMatch[] = [];
    for (
      let index = 0;
      index < batch.lines.length && matches.length < batch.limit;
      index++
    ) {
      matches.push(
        ...matchLine(
          batch.lines[index],
          batch.firstLine + index,
          regex,
          batch.limit - matches.length,
        ),
      );
    }
    reply = { id, matches };
  } catch (error) {
    reply = {
      id,
      error:
        error instanceof Error ? error.message : "Regex evaluation failed.",
    };
  }
  self.postMessage(reply);
};
