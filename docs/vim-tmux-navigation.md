# Vim / Tmux Navigation

This guide shows how to share `Ctrl-h/j/k/l` window navigation between vim splits, tmux panes, and ClawTab panes -- so the same key moves the cursor across all three layers without thinking about which one you are in.

The pattern is the same as [christoomey/vim-tmux-navigator](https://github.com/christoomey/vim-tmux-navigator), extended one layer up to ClawTab.

## How it works

Every ClawTab pane runs `tmux attach-session` in a local pty. So the layers, from outermost to innermost, are:

```
ClawTab pane  ->  tmux pane (inside the attached session)  ->  vim window (inside vim)
```

When you press `Ctrl-h`:

1. The keystroke flows through xterm.js into tmux.
2. Tmux's binding checks: is the foreground program vim? If yes, send `Ctrl-h` to vim.
3. Vim's mapping checks: is there a vim window to the left? If yes, move there. If no, run `cwtctl pane focus left`.
4. If tmux did not forward to vim, tmux's binding tries to move pane focus inside tmux. If already at the edge, run `cwtctl pane focus left`.
5. `cwtctl pane focus left` connects to the ClawTab desktop socket and tells the GUI to move focus to the ClawTab pane on the left.

ClawTab itself does not speculate about what is running in the pane. The user's tmux and vim configs decide who handles the keystroke. ClawTab only changes pane focus when explicitly told to via `cwtctl`.

## Step 1 -- Clear ClawTab's default bindings

By default, ClawTab binds `Ctrl-h/j/k/l` to its own `move_pane_*` shortcuts at the xterm layer. To opt into the cooperative flow, clear those four bindings:

1. Open ClawTab Settings -> Shortcuts.
2. Clear `Move pane left`, `Move pane right`, `Move pane up`, `Move pane down`.

With those cleared, ClawTab no longer consumes `Ctrl-h/j/k/l` -- the keys flow through to tmux in the pty.

## Step 2 -- tmux.conf

```tmux
# Smart pane switching with awareness of vim
is_vim="ps -o state= -o comm= -t '#{pane_tty}' \
    | grep -iqE '^[^TXZ ]+ +(\\S+\\/)?g?\\.?(view|n?vim?x?)(diff)?$'"

bind-key -n C-h if-shell "$is_vim" "send-keys C-h" \
    { if-shell -F '#{pane_at_left}'   { run-shell -b "cwtctl pane focus left  >/dev/null 2>&1" } { select-pane -L } }
bind-key -n C-j if-shell "$is_vim" "send-keys C-j" \
    { if-shell -F '#{pane_at_bottom}' { run-shell -b "cwtctl pane focus down  >/dev/null 2>&1" } { select-pane -D } }
bind-key -n C-k if-shell "$is_vim" "send-keys C-k" \
    { if-shell -F '#{pane_at_top}'    { run-shell -b "cwtctl pane focus up    >/dev/null 2>&1" } { select-pane -U } }
bind-key -n C-l if-shell "$is_vim" "send-keys C-l" \
    { if-shell -F '#{pane_at_right}'  { run-shell -b "cwtctl pane focus right >/dev/null 2>&1" } { select-pane -R } }
```

The `is_vim` heuristic is the standard one used by `vim-tmux-navigator`. It checks whether the foreground process in the tmux pane looks like vim/nvim/view. If so, the keystroke is sent to vim. If not, tmux either moves pane focus internally (`select-pane -L`) or, when already at the edge of the tmux pane tree, hands off to ClawTab via `cwtctl pane focus`.

`#{pane_at_left}` and friends are tmux format flags that are true when the active pane is at the corresponding edge of its window.

## Step 3 -- nvim mapping

For nvim, install a small Lua snippet that handles edge handoff inside vim. Pattern based on [alexghergh/nvim-tmux-navigation](https://github.com/alexghergh/nvim-tmux-navigation):

```lua
local function navigate(direction)
  local cmd_map = { h = "wincmd h", j = "wincmd j", k = "wincmd k", l = "wincmd l" }
  local dir_map = { h = "left", j = "down", k = "up", l = "right" }

  return function()
    local prev_winnr = vim.fn.winnr()
    vim.cmd(cmd_map[direction])
    if vim.fn.winnr() == prev_winnr then
      -- vim did not move (we are at the edge); hand off to ClawTab
      vim.fn.system({ "cwtctl", "pane", "focus", dir_map[direction] })
    end
  end
end

vim.keymap.set("n", "<C-h>", navigate("h"), { silent = true })
vim.keymap.set("n", "<C-j>", navigate("j"), { silent = true })
vim.keymap.set("n", "<C-k>", navigate("k"), { silent = true })
vim.keymap.set("n", "<C-l>", navigate("l"), { silent = true })
```

For classic vim, the equivalent uses `winnr()` and `silent !cwtctl pane focus <dir>`.

## Verifying

1. Open two ClawTab panes side by side.
2. In the right pane, run `nvim` and `:vsplit` once to get two vim windows.
3. From the rightmost vim window, press `Ctrl-h`. Cursor moves to the left vim window.
4. Press `Ctrl-h` again. Cursor leaves vim, ClawTab focuses the left ClawTab pane.
5. In the left ClawTab pane (no vim running), press `Ctrl-h`. tmux's binding runs `cwtctl pane focus left` -- nothing happens because there is no pane further left, which is the expected no-op.

If `Ctrl-h` does nothing inside vim, double-check that ClawTab's `Move pane left` shortcut is cleared in Settings.

## Troubleshooting

**ClawTab still consumes `Ctrl-h`.** The xterm-layer binding is still set. Open Settings -> Shortcuts and clear all four `Move pane *` rows.

**`cwtctl pane focus left` returns "Failed to connect".** The desktop app is not running. `pane focus` requires the GUI process; the daemon does not handle it. Start ClawTab.

**Tmux does not detect vim.** The `is_vim` regex matches typical vim/nvim binaries. If you use a custom binary name, extend the alternation in `is_vim` to match it.

**Cursor moves wrong direction inside nvim.** Confirm the `cmd_map` and `dir_map` entries match (`h` -> `wincmd h` -> `left`, etc.). The vim direction key and the ClawTab direction string must agree.
