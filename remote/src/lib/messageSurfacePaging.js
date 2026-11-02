// The mobile document uses the same cards for dragging, previews, and navigation.
(() => {
  const host = document.getElementById("surface");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const easing = "cubic-bezier(0.22,1,0.36,1)";
  let drag = null, transition = null;
  const translate = x => `translate3d(${x}px,0,0)`;

  function finish() {
    const active = transition; transition = null;
    if (active) {
      active.animations.forEach(animation => animation.cancel());
      active.card.style.transform = "";
      active.card.style.opacity = "";
      active.outgoing?.remove();
    }
    if (drag) {
      drag.card.style.transform = "";
      drag.neighbor?.remove();
      drag = null;
    }
    delete host.dataset.paging;
  }

  function page(node, rect, showDetails, replying = false) {
    const wrapper = document.createElement("div");
    wrapper.className = `${host.className} gallery-page`;
    wrapper.classList.toggle("details-open", showDetails);
    wrapper.classList.toggle("shell-reply", replying);
    wrapper.inert = true;
    wrapper.setAttribute("aria-hidden", "true");
    Object.assign(wrapper.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    node.style.transform = "";
    node.removeAttribute("id");
    node.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
    wrapper.append(node);
    return wrapper;
  }

  function geometry(card) {
    const bounds = card.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, top: bounds.top, left: bounds.left };
  }

  function neighbor(step) {
    if (drag.step === step) return;
    drag.neighbor?.remove(); drag.neighbor = null; drag.step = step;
    const preview = window.nfn.pagePreview(step);
    if (!preview) return;
    drag.neighbor = page(preview.node, drag.rect, preview.details);
    drag.neighbor.dataset.pageStep = String(step);
    document.body.append(drag.neighbor);
    for (const element of drag.neighbor.querySelectorAll(".details-content,.message-thread")) element.scrollTop = element.scrollHeight;
  }

  function begin(card) {
    finish();
    if (!card?.isConnected) return false;
    const rect = geometry(card);
    if (!rect.width) return false;
    drag = { card, rect, dx: 0, step: 0, neighbor: null };
    host.dataset.paging = "dragging";
    return true;
  }

  function move(dx) {
    if (!drag) return;
    neighbor(dx < 0 ? 1 : -1);
    drag.dx = Math.max(-drag.rect.width, Math.min(drag.rect.width, dx));
    if (!drag.neighbor) drag.dx *= .2;
    if (reducedMotion.matches) {
      drag.card.style.transform = "";
      if (drag.neighbor) { drag.neighbor.style.transform = ""; drag.neighbor.style.opacity = "0"; }
      return;
    }
    drag.card.style.transform = translate(drag.dx);
    if (drag.neighbor) { drag.neighbor.style.opacity = ""; drag.neighbor.style.transform = translate(drag.step * drag.rect.width + drag.dx); }
  }

  function animate(card, outgoing, frames) {
    const active = transition = { card, outgoing, animations: [] };
    host.dataset.paging = "settling";
    for (const [element, keyframes] of frames) {
      active.animations.push(element.animate(keyframes, { duration: 500, easing, fill: "both" }));
    }
    Promise.all(active.animations.map(animation => animation.finished.catch(() => {}))).then(() => {
      if (transition === active) finish();
    });
  }

  function cancel() {
    if (!drag) return;
    const { card, neighbor, dx, rect, step } = drag;
    drag = null;
    const frames = reducedMotion.matches ? [[card, [{ opacity: 1 }, { opacity: 1 }]]]
      : [[card, [{ transform: translate(dx) }, { transform: translate(0) }]]];
    if (neighbor) {
      frames.push([neighbor, reducedMotion.matches ? [{ opacity: 0 }, { opacity: 0 }]
        : [{ transform: translate(step * rect.width + dx) }, { transform: translate(step * rect.width) }]]);
    }
    animate(card, neighbor, frames);
  }

  function release(dx, velocity, cancelled = false) {
    if (!drag) return false;
    move(dx);
    const step = host.querySelector(dx < 0 ? ".nav-step.next" : ".nav-step.previous");
    const commit = !cancelled && step && !step.hidden && (Math.abs(dx) >= Math.min(96, drag.rect.width * .2)
      || Math.abs(dx) >= 24 && Math.abs(velocity) > .5 && Math.sign(velocity) === Math.sign(dx));
    if (!commit) { cancel(); return false; }
    step.click();
    return true;
  }

  function willNavigate(step) {
    if (!drag) begin(host.querySelector(":scope > .card"));
    if (!drag) return;
    const { card, rect, dx } = drag;
    const clone = card.cloneNode(true);
    const source = card.querySelectorAll("*"), copy = clone.querySelectorAll("*");
    const positions = Array.from(source, (element, index) => [copy[index], element.scrollTop, element.scrollLeft]);
    const outgoing = page(clone, rect, host.classList.contains("details-open"), host.classList.contains("shell-reply"));
    drag.neighbor?.remove();
    drag.outgoing = outgoing; drag.positions = positions; drag.step = step; drag.dx = dx;
  }

  function didNavigate() {
    if (!drag?.outgoing) return;
    const { outgoing, rect, dx, step, positions } = drag; drag = null;
    const card = host.querySelector(":scope > .card");
    if (!card) { outgoing.remove(); finish(); return; }
    document.body.append(outgoing);
    positions.forEach(([element, top, left]) => { element.scrollTop = top; element.scrollLeft = left; });
    const frames = reducedMotion.matches
      ? [[card, [{ opacity: 0 }, { opacity: 1 }]], [outgoing, [{ opacity: 1 }, { opacity: 0 }]]]
      : [[card, [{ transform: translate(step * rect.width + dx) }, { transform: translate(0) }]],
        [outgoing, [{ transform: translate(dx) }, { transform: translate(-step * rect.width) }]]];
    animate(card, outgoing, frames);
  }

  function opening() {
    if (!drag?.outgoing) finish();
  }
  function reconcile() {
    if (transition && !transition.card.isConnected || drag && !drag.card.isConnected && !drag.outgoing) finish();
  }
  window.nfnPaging = { begin, move, release, cancel, finish, willNavigate, didNavigate, opening, reconcile };
  window.addEventListener("resize", finish);
  document.addEventListener("visibilitychange", () => { if (document.hidden) finish(); });
})();
