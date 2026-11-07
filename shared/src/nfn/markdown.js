/* Markdown for the shared desktop and mobile message surface. */
(() => {
  "use strict";
  const parser = new marked.Marked({ gfm: true, breaks: true });
  const escape = text => String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  // Attachments use the existing media renderer; body HTML is displayed as text.
  parser.use({ renderer: {
    html: token => escape(token.text),
    br: () => "<br>\n",
    image: token => escape(token.text),
  } });
  const messageLinksCache = new Map();
  window.nfnMessageLinks = text => {
    text = String(text || "");
    if (messageLinksCache.has(text)) return messageLinksCache.get(text);
    const links = new Map();
    const add = (href, label) => {
      try {
        const url = new URL(href);
        if (!["https:", "http:"].includes(url.protocol) || links.has(url.href)) return;
        links.set(url.href, { label: label || url.href, url: url.href });
      } catch {}
    };
    const scan = text => {
      for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
        let href = match[0].replace(/[.,;:!?]+$/, "");
        for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
          while (href.endsWith(close) && href.split(close).length > href.split(open).length) href = href.slice(0, -1);
        }
        add(href);
      }
    };
    marked.walkTokens(parser.lexer(text), token => {
      if (token.type === "link") add(token.href, token.text);
      // Agents often wrap deliverable URLs in backticks.
      if (token.type === "code" || token.type === "codespan") scan(token.text);
    });
    const result = [...links.values()];
    if (messageLinksCache.size >= 32) messageLinksCache.delete(messageLinksCache.keys().next().value);
    messageLinksCache.set(text, result);
    return result;
  };
  window.nfnMarkdown = (parent, text, openLink) => {
    parent.classList.add("markdown");
    parent.innerHTML = DOMPurify.sanitize(parser.parse(text).trim(), {
      ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a", "table", "thead", "tbody", "tr", "th", "td", "input"],
      ALLOWED_ATTR: ["href", "title", "start", "align", "type", "checked", "disabled"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    for (const input of parent.querySelectorAll("input")) { input.type = "checkbox"; input.disabled = true; }
    for (const link of parent.querySelectorAll("a")) {
      const href = link.getAttribute("href") || "";
      if (!/^(https?:\/\/|mailto:)/i.test(href)) { link.removeAttribute("href"); continue; }
      link.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); openLink(href); });
    }
  };
})();
