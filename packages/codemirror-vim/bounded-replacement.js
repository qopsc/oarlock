// String.replace semantics, with an output budget before allocating the result.
const MAX_UNITS = 8_388_608;
const MAX_REPLACEMENT = 4096;
const BLOCK_PARTS = 1024;

export function boundedReplace(value, query, replacement) {
  if (value.length > MAX_UNITS) throw Error("Vim regex input exceeds 16 MiB.");
  if (replacement.length > MAX_REPLACEMENT)
    throw Error("Vim replacement exceeds 4,096 characters.");
  let units = 0,
    parts = [],
    blocks = [];
  const append = (source, start = 0, end = source.length) => {
    const size = end - start;
    if (size > MAX_UNITS - units)
      throw Error("Vim regex result exceeds 16 MiB.");
    units += size;
    if (!size) return;
    parts.push(
      start === 0 && end === source.length ? source : source.slice(start, end),
    );
    if (parts.length === BLOCK_PARTS) {
      blocks.push(parts.join(""));
      parts = [];
    }
  };
  const expand = (match) => {
    let start = 0;
    for (let i = 0; i < replacement.length; i++) {
      if (replacement[i] !== "$" || i + 1 >= replacement.length) continue;
      const next = replacement[i + 1];
      let consumed = 0,
        insert = null,
        range = null;
      if (next === "$") {
        consumed = 2;
        insert = "$";
      } else if (next === "&") {
        consumed = 2;
        insert = match[0];
      } else if (next === "`") {
        consumed = 2;
        range = [0, match.index];
      } else if (next === "'") {
        consumed = 2;
        range = [match.index + match[0].length, value.length];
      } else if (next === "<" && match.groups !== undefined) {
        const end = replacement.indexOf(">", i + 2);
        if (end !== -1) {
          consumed = end - i + 1;
          insert = match.groups[replacement.slice(i + 2, end)] ?? "";
        }
      } else if (next >= "0" && next <= "9") {
        const two = replacement.slice(i + 1, i + 3);
        const pair = /^\d\d$/.test(two) ? Number(two) : 0;
        const one = Number(next);
        if (pair > 0 && pair < match.length) {
          consumed = 3;
          insert = match[pair] ?? "";
        } else if (one > 0 && one < match.length) {
          consumed = 2;
          insert = match[one] ?? "";
        }
      }
      if (!consumed) continue;
      append(replacement, start, i);
      if (range) append(value, range[0], range[1]);
      else append(insert);
      i += consumed - 1;
      start = i + 1;
    }
    append(replacement, start);
  };

  let cursor = 0;
  if (query.global) query.lastIndex = 0;
  for (;;) {
    const match = query.exec(value);
    if (!match) break;
    append(value, cursor, match.index);
    expand(match);
    cursor = match.index + match[0].length;
    if (!query.global) break;
    if (match[0].length === 0) {
      const at = query.lastIndex;
      const first = value.charCodeAt(at);
      const second = value.charCodeAt(at + 1);
      query.lastIndex +=
        (query.unicode || query.unicodeSets) &&
        first >= 0xd800 &&
        first <= 0xdbff &&
        second >= 0xdc00 &&
        second <= 0xdfff
          ? 2
          : 1;
    }
  }
  append(value, cursor);
  if (parts.length) blocks.push(parts.join(""));
  return blocks.join("");
}
