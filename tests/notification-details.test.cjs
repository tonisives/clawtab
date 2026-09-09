const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let question = (id, paneId = id) => ({
  question_id: id, pane_id: paneId, cwd: `/Users/test/work/${id}`,
  context_lines: `Allow ${id}?`, matched_job: null, options: [],
});

let harness = (questions) => {
  let state = { questions };
  let refs = [], cursor = 0, effects = [];
  let element = (type, props) => ({ type, props });
  let modules = {
    react: {
      useRef: (value) => refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
      useEffect: (effect) => effects.push(effect),
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { StyleSheet: { create: (styles) => styles }, Pressable: 'Pressable', View: 'View', Text: 'Text' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '@clawtab/shared': { colors: {}, spacing: {}, stripSeparators: (value) => value },
    '../store/notifications': { useNotificationStore: (select) => select(state) },
    '../demo/data': { DEMO_QUESTIONS: [] },
  };
  let source = fs.readFileSync(path.resolve(__dirname, '../remote/src/components/NextNotification.tsx'), 'utf8');
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  let exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  } });
  return {
    state,
    render: (props) => {
      cursor = 0;
      effects = [];
      let tree = exports.NextNotification(props);
      effects.forEach((effect) => effect());
      return tree?.props.children ?? null;
    },
  };
};

test('next chevron cycles pending questions in the same detail selection callback', () => {
  let view = harness(['a', 'b', 'c'].map((id) => question(id)));
  let selected;
  let props = { paneId: 'a', onSelect: (value) => { selected = value; } };
  let button = view.render(props);
  assert.match(button.props.accessibilityLabel, /~\/work\/b\. Allow b\?/);
  button.props.onPress();
  assert.equal(selected.question_id, 'b');
  view.render({ ...props, paneId: 'b' }).props.onPress();
  assert.equal(selected.question_id, 'c');
  view.render({ ...props, paneId: 'c' }).props.onPress();
  assert.equal(selected.question_id, 'a');
});

test('answering retains the successor and does not switch until tapped', () => {
  let view = harness(['a', 'b', 'c'].map((id) => question(id)));
  let selected;
  let props = { paneId: 'b', onSelect: (value) => { selected = value; } };
  view.render(props);
  view.state.questions = view.state.questions.filter((item) => item.question_id !== 'b');
  let button = view.render(props);
  assert.equal(selected, undefined);
  button.props.onPress();
  assert.equal(selected.question_id, 'c');
  view.state.questions = [question('a')];
  view.render(props).props.onPress();
  assert.equal(selected.question_id, 'a');
  view.state.questions = [];
  assert.equal(view.render(props), null);
});

test('hides when only the current pane has questions and skips that pane when cycling', () => {
  let view = harness([question('a'), question('a2', 'a')]);
  let selected;
  let props = { paneId: 'a', onSelect: (value) => { selected = value; } };
  assert.equal(view.render(props), null);
  view.state.questions.push(question('b'));
  view.render(props).props.onPress();
  assert.equal(selected.question_id, 'b');
});

test('job-only targets skip their current question', () => {
  let current = { ...question('a'), matched_job: 'build' };
  let view = harness([current, question('b')]);
  let selected;
  view.render({ jobName: 'build', onSelect: (value) => { selected = value; } }).props.onPress();
  assert.equal(selected.question_id, 'b');
});

test('preview uses the question without ANSI styling or answer choices', () => {
  let next = { ...question('b'), context_lines: 'Some shell output\n\x1b[32mAllow this command?\x1b[0m\n1. Yes\n2. No' };
  let view = harness([question('a'), next]);
  let button = view.render({ paneId: 'a', onSelect: () => {} });
  assert.equal(button.props.accessibilityLabel, 'Next notification: ~/work/b. Allow this command?');
});

test('terminal details switch panes locally without touching the router', () => {
  let states = [], cursor = 0;
  let element = (type, props, key) => ({ type, props, key });
  let modules = {
    react: {
      useState: (initial) => {
        let index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value) => { states[index] = value; }];
      },
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Keyboard: { dismiss: () => {} }, StyleSheet: { create: (styles) => styles } },
    'expo-router': {
      useLocalSearchParams: () => ({ pane_id: '_pct_1', source: 'notifications' }),
      useRouter: () => { throw new Error('Switching questions must not use navigation'); },
    },
    '@clawtab/shared': { colors: {}, spacing: {}, radius: {} },
  };
  let source = fs.readFileSync(path.resolve(__dirname, '../remote/app/process/[pane_id].tsx'), 'utf8');
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  let exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => modules[name] ?? {} });
  let render = () => { cursor = 0; return exports.default(); };
  let first = render();
  assert.equal(first.props.pane_id, '%1');
  first.props.onSelectNotification(question('b', '%2'));
  let next = render();
  assert.equal(next.props.pane_id, '%2');
  assert.equal(next.props.preserveTerminal, true);
  assert.notEqual(next.key, first.key, 'Switching resets terminal state for the selected pane');
  next.props.onSelectNotification(question('a', '%1'));
  assert.equal(render().props.pane_id, '%1');
});
