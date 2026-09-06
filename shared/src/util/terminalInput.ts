/** Encode terminal input as UTF-8 bytes before base64, including smart punctuation. */
export let encodeTerminalInput = (text: string): string => {
  let bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let point = text.codePointAt(index) ?? 0xfffd;
    if (point > 0xffff) index += 1;
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
    else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
  }
  let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    let triplet = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    output += alphabet[(triplet >> 18) & 63] + alphabet[(triplet >> 12) & 63];
    output += i + 1 < bytes.length ? alphabet[(triplet >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? alphabet[triplet & 63] : "=";
  }
  return output;
};
