// Run against the production renderer with fixture.todos and the todo bridge enabled.
(async () => {
  if (!window.fixture.todos.items.length) {
    window.fixture.todos = { linked: true, note: '/notes/today.md', items: [
      { id: 'linked', text: 'Review release', group: 'clawtab', depth: 0, checked: false, agent: { pane: '%8', state: 'working' } },
      { id: 'unlinked', text: 'Research', group: 'gp', depth: 0, checked: false }
    ] };
    window.nfn.receive({ type: 'todos', todos: window.fixture.todos });
  }
  const checks = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  const click = selector => document.querySelector(selector).click();
  if (!document.querySelector('.todo-view')) click('.todo-toggle');
  await wait();
  assert(document.querySelectorAll('.todo-row').length === window.fixture.todos.items.length, 'all source tasks appear once');
  const groups = [...document.querySelectorAll('.todo-group')].map(node => node.textContent.split(' · ')[0]);
  assert(groups.join(',') === [...new Set(window.fixture.todos.items.map(item => item.group))].sort().join(','), 'tasks are grouped alphabetically');
  click('.todo-refresh'); await wait();
  assert(window.fixture.calls.some(command => command.op === 'todo_refresh'), 'refresh agents requests conversation rediscovery');
  const first = window.fixture.todos.items[0];
  const original = first.checked, originalDone = window.fixture.todos.items.filter(item => item.checked).length;
  click('.todo-row input'); await wait();
  assert(first.checked !== original && document.querySelector('.todo-heading .hint').textContent.startsWith(`${originalDone + (original ? -1 : 1)} /`), 'checkbox updates completion totals through the bridge');
  assert(document.querySelector('.todo-ring').style.getPropertyValue('--todo-progress') !== '0deg', 'circular indicator reflects checked tasks');
  click('.todo-row input'); await wait();
  const text = document.querySelector('[aria-label="New task"]'), group = document.querySelector('[aria-label="Task group"]');
  text.value = 'Browser verification task'; text.dispatchEvent(new Event('input'));
  group.value = 'gp'; group.dispatchEvent(new Event('input'));
  document.querySelector('.todo-add').requestSubmit(); await wait();
  assert(window.fixture.calls.some(command => command.op === 'todo_add' && command.text === 'Browser verification task' && command.group === 'gp'), 'create task passes the selected group and text');
  assert(document.querySelector('[aria-label="New task"]').value === '', 'successful creation clears the task draft');
  click('.todo-agent'); await wait();
  assert(window.fixture.calls.some(command => command.op === 'todo_focus' && command.id === first.id), 'open agent targets the selected mapped task');
  window.fixture.todoError = 'Source note changed';
  click('.todo-row input'); await wait();
  assert(document.querySelector('.todo-view [role="status"]').textContent === 'Source note changed' && !first.checked, 'failed source writes display an error without changing completion');
  window.fixture.todoError = null;
  const start = [...document.querySelectorAll('.todo-agent')].find(button => button.textContent === 'Start agent');
  start.click(); await wait();
  assert(document.querySelector('.todo-options').open && document.querySelector('[role="status"]').textContent.includes('working directory'), 'starting an agent asks for its working directory');
  const cwd = document.querySelector('[aria-label="Agent working directory"]'); cwd.value = '/projects/clawtab'; cwd.dispatchEvent(new Event('input'));
  [...document.querySelectorAll('.todo-agent')].find(button => button.textContent === 'Start agent').click(); await wait();
  assert(window.fixture.calls.some(command => command.op === 'todo_start' && command.cwd === '/projects/clawtab'), 'start agent sends the chosen working directory and task');
  const source = document.querySelector('[aria-label="Markdown source path"]'); source.value = '/notes/today.md'; source.dispatchEvent(new Event('input'));
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Link Markdown checklist').click(); await wait();
  assert(window.fixture.calls.some(command => command.op === 'todo_link' && command.note === '/notes/today.md'), 'link source uses the chosen Markdown path');
  const draft = document.querySelector('[aria-label="New task"]'); draft.value = 'Keep my draft'; draft.dispatchEvent(new Event('input')); draft.focus();
  window.fixture.todos.items[0].agent = { ...first.agent, state: 'blocked', summary: 'Waiting for a decision' };
  window.nfn.receive({ type: 'todos', todos: window.fixture.todos }); await wait();
  assert(document.querySelector('.todo-state.blocked')?.textContent === 'Blocked', 'external status changes update the task view');
  assert(document.querySelector('[aria-label="New task"]').value === 'Keep my draft' && document.activeElement.getAttribute('aria-label') === 'New task', 'external refresh preserves the focused task draft');
  window.fixture.records.set('second', window.fixture.record('second'));
  window.nfn.receive(window.fixture.snapshot('second')); await wait();
  assert(document.querySelector('.todo-view') && !document.querySelector('.card'), 'new messages preserve the open task view');
  click('[aria-label="Notification list"]'); await wait();
  assert(document.querySelector('.queue') && !document.querySelector('.todo-view'), 'message list remains accessible from tasks');
  click('.todo-toggle'); await wait();
  window.nfn.setPlacement({ placement: 'notch', notch_width: 220, overlap: 38, max_width: 1000, max_height: 860, reduce_motion: true });
  assert(document.querySelector('#surface').getBoundingClientRect().width === 620, 'notch task list keeps its reading width');
  click('.todo-toggle'); await wait();
  assert(!document.querySelector('.todo-view') && document.querySelector('.todo-ring'), 'closing tasks preserves the compact progress ring');
  click('.todo-toggle'); await wait();
  return { passed: checks.length, checks };
})();
