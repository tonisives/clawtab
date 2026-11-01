// xterm owns terminal state; a selectable document owns native iOS scrolling.
export const smoothTerminalScript = String.raw`
if (__SMOOTH_SCROLL__) {
  var grid = document.getElementById('terminal');
  grid.style.visibility = 'hidden';
  grid.style.position = 'absolute';
  grid.style.pointerEvents = 'none';
  var scroller = document.createElement('div');
  scroller.style.cssText = 'position:absolute;inset:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain';
  var output = document.createElement('pre');
  output.style.cssText = 'margin:0;min-height:100%;box-sizing:border-box;padding:8px;color:#e4e4e4;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text;font-family:monospace;font-size:14px;line-height:1.2';
  scroller.append(output); document.body.append(scroller);
  var dirty = true, scheduled = false;
  function hasSelection() {
    var selection = window.getSelection();
    return selection && !selection.isCollapsed && (output.contains(selection.anchorNode) || output.contains(selection.focusNode));
  }
  function paintOutput() {
    scheduled = false;
    if (!dirty || hasSelection()) return;
    dirty = false;
    output.style.fontSize = term.options.fontSize + 'px';
    output.style.fontFamily = term.options.fontFamily;
    var follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    var buffer = term.buffer.active, fragment = document.createDocumentFragment();
    var last = buffer.length - 1;
    while (last > 0 && !buffer.getLine(last).translateToString(true).trim()) last--;
    for (var y = 0; y <= last; y++) {
      var line = buffer.getLine(y), length = line.translateToString(true).length;
      var cursorRow = y === buffer.baseY + buffer.cursorY;
      if (cursorRow) length = Math.max(length, buffer.cursorX + 1);
      var row = document.createElement('span');
      var previousSpan = null, previousStyle = '';
      for (var x = 0; x < term.cols; x++) {
        var cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        var chars = cell.getChars() || ' ';
        if (x >= length && cell.isBgDefault()) break;
        var span = document.createElement('span'); span.textContent = chars;
        function color(value, rgb, palette) {
          if (rgb) return '#' + value.toString(16).padStart(6, '0');
          if (palette) return paletteColor(value);
          return '';
        }
        function paletteColor(n) {
          var base = ['#161616','#ff453a','#32d74b','#ff9f0a','#7986cb','#da77f2','#66d9e8','#e4e4e4','#555','#ff6b6b','#51cf66','#ffd43b','#91d5ff','#e599f7','#99e9f2','#fff'];
          if (n < 16) return base[n];
          if (n >= 232) { var gray = 8 + (n - 232) * 10; return 'rgb('+gray+','+gray+','+gray+')'; }
          n -= 16; var c = function(v) { return v ? 55 + v * 40 : 0; };
          return 'rgb('+c(Math.floor(n/36))+','+c(Math.floor(n%36/6))+','+c(n%6)+')';
        }
        var fg = color(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette());
        var bg = color(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette());
        if (cell.isInverse()) { var swap = fg || '#e4e4e4'; fg = bg || '#1c1c1e'; bg = swap; }
        span.style.color = fg; span.style.backgroundColor = bg;
        if (cell.isBold()) span.style.fontWeight = 'bold';
        if (cell.isDim()) span.style.opacity = '.6';
        if (cell.isUnderline()) span.style.textDecoration = 'underline';
        if (cursorRow && x === buffer.cursorX) span.style.boxShadow = 'inset 1px 0 #7986cb';
        var style = span.style.cssText;
        if (previousSpan && style === previousStyle) previousSpan.textContent += chars;
        else { row.append(span); previousSpan = span; previousStyle = style; }
      }
      fragment.append(row);
      if (y < last && !buffer.getLine(y + 1).isWrapped) fragment.append(document.createTextNode('\n'));
    }
    output.replaceChildren(fragment);
    if (follow) scroller.scrollTop = scroller.scrollHeight;
  }
  function scheduleOutput() {
    dirty = true;
    if (!scheduled) { scheduled = true; setTimeout(paintOutput, 100); }
  }
  term.onWriteParsed(scheduleOutput);
  document.addEventListener('selectionchange', function() { if (!hasSelection() && dirty) scheduleOutput(); });
  var scrollTime = 0, scrollY = null;
  scroller.addEventListener('touchmove', function(e) {
    var y = e.touches[0].clientY, now = Date.now();
    if (scrollY !== null && Math.abs(y-scrollY) > 2 && now-scrollTime > 100) {
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'scroll', direction:y < scrollY ? 'down' : 'up'}));
      scrollTime = now;
    }
    scrollY = y;
  }, {passive:true});
  var origin = null;
  scroller.addEventListener('touchstart', function(e) { var t = e.touches[0]; origin = {x:t.clientX,y:t.clientY,time:Date.now()}; scrollY = t.clientY; }, {passive:true});
  scroller.addEventListener('touchend', function(e) {
    var t = e.changedTouches[0], start = origin; origin = null;
    if (start && Date.now()-start.time < 300 && Math.hypot(t.clientX-start.x,t.clientY-start.y) < 8 && !hasSelection())
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'focus'}));
  }, {passive:true});
  window.setVisualOffset = function(px) {
    var follow = scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight < 40;
    scroller.style.bottom = Math.max(0, px) + 'px';
    if (follow) scroller.scrollTop = scroller.scrollHeight;
  };
  scheduleOutput();
}
`;
