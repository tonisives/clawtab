export function shellKeyboardEdit(previous: string, value: string) {
  let prefix = 0;
  while (prefix < previous.length && prefix < value.length && previous[prefix] === value[prefix]) prefix++;
  // Keep a shared UTF-16 surrogate pair in the replacement, not half of it.
  if (prefix > 0 && /[\uD800-\uDBFF]/.test(previous[prefix - 1])) prefix--;
  return "\x7f".repeat(Array.from(previous.slice(prefix)).length) + value.slice(prefix).replace(/\r\n|\n/g, "\r");
}
