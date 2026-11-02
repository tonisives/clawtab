# Message Markdown dependencies

Pinned browser distributions, bundled locally for all message surfaces:

- Marked 17.0.1: https://cdn.jsdelivr.net/npm/marked@17.0.1/lib/marked.umd.js
- DOMPurify 3.3.1: https://cdn.jsdelivr.net/npm/dompurify@3.3.1/dist/purify.min.js

Licenses are adjacent to the source files. Update the pinned files and run the
message Markdown browser checks when upgrading. The renderer displays raw HTML
as text, sanitizes generated markup, and opens HTTP, HTTPS, and mailto links
through the host application.
