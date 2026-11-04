// Vector artwork and spring timings from tools/claw-motion-preview/index.tsx.
// Keep the startup mark at full size; the slash begins when account loading ends.
export const startupBackground = "#11111f";
const artwork = `  const arrivalClaws = [{"d":"M625 130 L588 156 L536 197 L474 251 L420 301 L404 314 L400 318 L396 324 L392 337 L384 353 L370 367 L348 382 L342 394 L298 464 L250 552 L250 554 L238 576 L238 578 L228 597 L224 608 L210 635 L190 689 L190 691 L204 676 L220 652 L260 597 L276 577 L280 570 L284 565 L320 518 L328 511 L360 472 L362 471 L364 467 L378 454 L408 430 L416 408 L416 405 L426 384 L436 374 L454 360 L462 344 L484 317 L488 310 L492 305 L514 276 L516 275 L518 271 L558 221 L560 217 L622 141 L626 135 L626 131Z","top":[625,130],"bottom":[190,691]},{"d":"M778 185 L734 216 L680 256 L602 319 L566 350 L552 360 L548 367 L536 391 L532 396 L518 409 L492 422 L490 424 L482 436 L430 500 L398 545 L394 549 L342 630 L302 700 L268 767 L244 820 L238 836 L240 837 L241 838 L242 837 L250 828 L258 815 L320 731 L384 650 L460 561 L466 555 L498 533 L504 523 L504 521 L512 505 L516 499 L546 464 L550 456 L560 440 L564 436 L582 425 L586 421 L646 348 L648 347 L650 343 L658 335 L720 260 L722 259 L726 253 L766 207 L778 191 L780 186Z","top":[778,185],"bottom":[241,838]},{"d":"M821 324 L768 363 L682 432 L648 457 L646 459 L634 484 L618 498 L592 512 L590 515 L504 631 L502 634 L466 689 L430 749 L410 788 L412 792 L506 691 L596 600 L624 574 L650 557 L660 531 L666 521 L676 511 L690 501 L694 497 L700 488 L712 472 L720 463 L738 438 L816 338 L822 328 L822 325Z","top":[821,324],"bottom":[411,792]}];
  const arrivalClamp = value => Math.max(0, Math.min(1, value));
  function arrivalSpring(frame, damping, stiffness, mass = 1) {
    if (frame <= 0) return 0;
    const t = frame / 60, decay = damping / (2 * mass), frequency = Math.sqrt(stiffness / mass - decay * decay);
    return 1 - Math.exp(-decay * t) * (Math.cos(frequency * t) + decay / frequency * Math.sin(frequency * t));
  }
  function arrivalEase(value, x1, y1, x2, y2) {
    const x = arrivalClamp(value), curve = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
    let low = 0, high = 1;
    for (let i = 0; i < 16; i++) { const mid = (low + high) / 2; if (curve(mid, x1, x2) < x) low = mid; else high = mid; }
    return curve((low + high) / 2, y1, y2);
  }
  function arrivalFrame(icon, frame) {
    const scale = 1;
    const jolt = Math.sin(arrivalSpring(frame - 60, 9, 260) * Math.PI) * (1 - arrivalClamp((frame - 60) / 26)) ** 2;
    const rise = arrivalEase((frame - 82) / 16, .2, .8, .3, 1);
    const height = frame >= 150 ? 0 : rise * (1 - arrivalSpring(frame - 98, 10, 210));
    const lift = -64 * height, clawScale = 1 + .06 * height;
    const thump = frame >= 105 && frame < 135 ? Math.sin(arrivalSpring(frame - 105, 8, 300) * Math.PI) * (1 - arrivalClamp((frame - 105) / 30)) : 0;
    icon.querySelector('.arrival-tile').setAttribute('transform', \`translate(\${-10 * jolt} \${10 * jolt}) rotate(\${-2.2 * jolt} 512 512) translate(512 512) scale(\${scale * (1 + .02 * thump)} \${scale * (1 - .03 * thump)}) translate(-512 -512)\`);
    const shadow = icon.querySelector('.arrival-shadow feDropShadow');
    shadow.setAttribute('dx', -6 * Math.max(height, 0)); shadow.setAttribute('dy', 6 + 40 * Math.max(height, 0));
    shadow.setAttribute('stdDeviation', 5 + 16 * Math.max(height, 0)); shadow.setAttribute('flood-opacity', .35 + .25 * Math.max(height, 0));
    arrivalClaws.forEach((claw, i) => {
      const start = 56 + i * 4, progress = arrivalEase((frame - start) / 13, .55, 0, .25, 1);
      icon.querySelector(\`[data-cut="\${i}"]\`).setAttribute('stroke-dasharray', \`\${frame >= 150 ? 1 : progress} 2\`);
      icon.querySelector(\`[data-claw="\${i}"]\`).setAttribute('transform', \`translate(\${-lift * .25} \${lift}) scale(\${clawScale})\`);
      const glint = icon.querySelector(\`[data-glint="\${i}"]\`), [tx, ty] = claw.top, [bx, by] = claw.bottom;
      const fade = arrivalClamp((frame - start) / 2) * (1 - arrivalClamp((frame - start - 13) / 7));
      glint.setAttribute('opacity', frame >= 150 ? 0 : fade);
      glint.setAttribute('transform', \`translate(\${tx + (bx - tx) * progress} \${ty + (by - ty) * progress})\`);
    });
    icon.dataset.frame = String(frame);
  }
  function arrivalLogo() {
    const svg = (tag, attributes = {}) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; };
    const icon = svg('svg', {viewBox: '0 0 1024 1024', class: 'brand-icon claw-arrival', 'aria-hidden': 'true'});
    const defs = svg('defs'), gradient = svg('linearGradient', {id: 'arrival-fill', x1: 0, y1: 0, x2: 1, y2: 1});
    gradient.append(svg('stop', {offset: 0, 'stop-color': '#5659B6'}), svg('stop', {offset: 1, 'stop-color': '#4A4DA6'}));
    const filter = svg('filter', {id: 'arrival-shadow', class: 'arrival-shadow', x: '-50%', y: '-50%', width: '200%', height: '200%'});
    filter.append(svg('feDropShadow', {dx: 0, dy: 6, stdDeviation: 5, 'flood-color': '#14143f', 'flood-opacity': .4}));
    defs.append(gradient, filter); icon.append(defs);
    const tile = svg('g', {class: 'arrival-tile'}); tile.append(svg('rect', {width: 1024, height: 1024, rx: 228, fill: 'url(#arrival-fill)'}));
    arrivalClaws.forEach((claw, i) => {
      const [tx, ty] = claw.top, [bx, by] = claw.bottom, ex = (bx - tx) * .08, ey = (by - ty) * .08;
      const mask = svg('mask', {id: \`arrival-cut-\${i}\`, maskUnits: 'userSpaceOnUse', x: -200, y: -200, width: 1424, height: 1424});
      mask.append(svg('path', {'data-cut': i, d: \`M\${tx - ex} \${ty - ey} Q\${(tx + bx) / 2 - 70} \${(ty + by) / 2 - 20} \${bx + ex} \${by + ey}\`, pathLength: 1, stroke: '#fff', 'stroke-width': 300, fill: 'none', 'stroke-dasharray': '1 2'})); defs.append(mask);
      const group = svg('g', {mask: \`url(#arrival-cut-\${i})\`});
      group.append(svg('path', {d: claw.d, fill: '#2B2C6E'}), svg('path', {'data-claw': i, d: claw.d, fill: '#fff', filter: 'url(#arrival-shadow)'})); tile.append(group);
      const glint = svg('g', {'data-glint': i, opacity: 0});
      glint.append(svg('circle', {r: 24, fill: '#cfd1ff', opacity: .4}), svg('circle', {r: 9, fill: '#fff'})); tile.append(glint);
    });
    icon.append(tile); arrivalFrame(icon, 150); return icon;
  }
`;

export function clawArrivalDocument(playing: boolean, settled = false) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
  *{box-sizing:border-box}html,body{color-scheme:dark;margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center}svg{width:100%;height:100%;overflow:visible}
  </style></head><body><script>
  ${artwork}
  const icon = arrivalLogo(); document.body.append(icon);
  const report = () => { const message = JSON.stringify({clawArrival: "complete"});
    if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(message);
    else parent.postMessage(message, "*"); };
  arrivalFrame(icon, ${settled ? 150 : 56});
  if (${playing}) {
    let started;
    function advance(now) {
      started ??= now;
      const frame = Math.min(150, 56 + (now - started) * .06);
      arrivalFrame(icon, frame);
      if(frame < 150) requestAnimationFrame(advance); else report();
    }
    requestAnimationFrame(advance);
  }
  </script></body></html>`;
}
