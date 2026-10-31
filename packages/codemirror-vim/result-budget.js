const MAX_UNITS = 8_388_608;
/** Check before serializing: JSON.stringify itself can allocate an enormous
 * string when many captures refer to the same long input. */
export function checkResultBudget(value) {
  const pending = [value];
  const seen = new Set();
  let units = 0,
    nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > 100_000) throw Error("Vim regex result has too many values.");
    if (typeof item === "string") units += item.length;
    else if (item && typeof item === "object") {
      if (seen.has(item))
        throw Error("Vim regex result contains a repeated object.");
      seen.add(item);
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        if (pending.length + nodes >= 100_000)
          throw Error("Vim regex result has too many values.");
        units += key.length;
        pending.push(item[key]);
      }
    }
    if (units > MAX_UNITS) throw Error("Vim regex result exceeds 16 MiB.");
  }
  return value;
}
export function validateResult(request, value, length) {
  checkResultBudget(value);
  const captures = (match) =>
    Array.isArray(match) &&
    match.every((v) => v === undefined || typeof v === "string");
  const range = (v) =>
    v &&
    Number.isInteger(v.from) &&
    Number.isInteger(v.to) &&
    v.from >= 0 &&
    v.to >= v.from &&
    v.to <= length;
  let valid = false;
  if (request.kind === "replace") valid = typeof value === "string";
  else if (request.kind === "lines")
    valid =
      Array.isArray(value) &&
      value.length === request.lines.length &&
      value.every((v) => v === null || captures(v));
  else if (request.kind === "highlight") {
    let end = 0;
    valid =
      Array.isArray(value) &&
      value.length <= 10_000 &&
      value.every((v) => {
        if (!range(v) || v.from < end) return false;
        end = v.to;
        return true;
      });
  } else valid = value === null || (range(value) && captures(value.match));
  if (!valid) throw Error("Invalid Vim worker response.");
  return value;
}
