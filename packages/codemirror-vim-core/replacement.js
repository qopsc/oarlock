/** Upstream Vim replacement syntax, with an output budget before joining. */
export function expandVimReplacement(template, match) {
  if (template.length > 4096)
    throw Error("Vim replacement exceeds 4,096 characters.");
  const parts = [];
  let units = 0,
    from = 0;
  const append = (text) => {
    text = String(text);
    units += text.length;
    if (units > 8_388_608) throw Error("Vim replacement exceeds 16 MiB.");
    parts.push(text);
  };
  for (const token of template.matchAll(/\$(\d{1,3}|[$&])/g)) {
    append(template.slice(from, token.index));
    const value = token[1];
    if (value === "$") append("$");
    else if (value === "&") append(match[0]);
    else {
      let index = value;
      while (index.length && parseInt(index) >= match.length)
        index = index.slice(0, -1);
      append(index ? match[index] + value.slice(index.length) : token[0]);
    }
    from = token.index + token[0].length;
  }
  append(template.slice(from));
  return parts.join("");
}
