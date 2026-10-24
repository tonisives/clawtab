const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let loadLogin = (os, params = {}, options = {}) => {
  let events = [], browserRequests = 0, configured;
  let state = [], cursor = 0;
  let provider = { useIdTokenAuthRequest: (config) => {
    browserRequests++;
    assert.equal(os, 'web', 'native rendering must not create a browser OAuth request');
    assert.equal(config.webClientId, 'web-client');
    return [null, null, async () => ({ type: 'success', params: { id_token: 'web-identity' } })];
  } };
  let load = (file, dependencies) => {
    let exports = {};
    let source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    vm.runInNewContext(source, {
      exports, process: { env: { EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB: 'web-client' } },
      require: (name) => {
        if (name in dependencies) return dependencies[name];
        if (name.endsWith('/icon.png')) return 1;
        throw new Error('Unexpected login dependency: ' + name);
      },
    });
    return exports;
  };
  let browserAuth = load(require.resolve(`../remote/src/lib/googleBrowserAuth${os === 'web' ? '.web' : ''}.ts`), {
    'expo-auth-session/providers/google': provider,
  });
  let auth = { googleLogin: async (token) => events.push(['login', token]), appleLogin: async () => {},
    passwordLogin: async (email, password) => {
      events.push(['password', email, password]);
      if (options.passwordError) throw options.passwordError;
    } };
  let login = load(require.resolve('../remote/app/login.tsx'), {
    react: { useState: (initial) => {
      let index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => { state[index] = value; }];
    }, useCallback: (fn) => fn, useEffect: () => {} },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: os }, StyleSheet: { create: (value) => value },
      View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Modal: 'Modal', Image: 'Image', ScrollView: 'ScrollView' },
    'expo-router': { useLocalSearchParams: () => params, useRouter: () => ({
      push: (route) => events.push(['push', route]), replace: (route) => events.push(['replace', route]),
    }) },
    'expo-web-browser': { maybeCompleteAuthSession: () => {} },
    '../src/lib/googleBrowserAuth': browserAuth,
    '../src/store/auth': { useAuthStore: (selector) => selector(auth) },
    '../src/api/client': {}, '../src/theme/colors': { colors: {} }, '../src/theme/spacing': { radius: {}, spacing: {} },
    'expo-apple-authentication': {},
    '@react-native-google-signin/google-signin': {
      GoogleSignin: { configure: (config) => { configured = config; },
        signIn: async () => ({ type: 'success', data: { idToken: 'native-identity' } }) },
      isSuccessResponse: (response) => response.type === 'success',
    },
  });
  let all = (node) => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object'
    ? [node, ...all(node.props?.children)] : [];
  let render = () => { cursor = 0; return all(login.default()); };
  let press = (label) => render().find((node) => node.type === 'Pressable'
    && all(node).some((child) => child.type === 'Text' && child.props.children === label)).props.onPress();
  let input = (label) => render().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === label);
  render();
  return { events, configured, browserRequests, press, input, render };
};

for (let os of ['android', 'ios', 'web']) {
  test(`${os} login renders, opens demo, and completes Google sign-in using its platform flow`, async () => {
    let h = loadLogin(os);
    assert.equal(h.browserRequests, os === 'web' ? 1 : 0);
    if (os !== 'web') assert.equal(h.configured.webClientId, 'web-client');
    if (os === 'ios') assert.equal(h.render().some((node) => node.props?.children === 'Try demo'), false);
    else { h.press('Try demo'); assert.equal(h.events[0][1], '/demo'); }
    await h.press('Sign in with Google');
    assert.deepEqual(h.events.slice(os === 'ios' ? 0 : 1), [['login', os === 'web' ? 'web-identity' : 'native-identity'], ['replace', '/(tabs)']]);
  });
}

test('sign-in preserves the selected demo setup path', async () => {
  for (let os of ['ios', 'web']) for (let destination of ['add-machine', 'account']) {
    let h = loadLogin(os, { return_to: destination });
    await h.press('Sign in with Google');
    assert.deepEqual(h.events.at(-1), ['replace', `/${destination}`]);
  }
});

test('email sign-in uses the existing account and preserves the selected destination', async () => {
  for (let os of ['android', 'ios', 'web']) {
    let h = loadLogin(os, { return_to: 'machines' });
    h.press('Sign in with email');
    h.input('Email').props.onChangeText(' reviewer@example.com ');
    h.input('Password').props.onChangeText(' password with spaces ');
    assert.equal(h.input('Password').props.secureTextEntry, true);
    await h.press('Sign in');
    assert.deepEqual(h.events, [['password', 'reviewer@example.com', ' password with spaces '], ['replace', '/machines']]);
    assert.equal(h.input('Password').props.value, '');
  }
});

test('email sign-in validates missing fields and keeps rejected credentials on the sign-in screen', async () => {
  let h = loadLogin('android', {}, { passwordError: Object.assign(new Error('Unauthorized'), { status: 401 }) });
  h.press('Sign in with email');
  await h.press('Sign in');
  assert.equal(h.events.length, 0);
  assert.ok(h.render().some((node) => node.props?.children === 'Enter your email and password.'));
  h.input('Email').props.onChangeText('reviewer@example.com');
  h.input('Password').props.onChangeText('wrong-password');
  await h.press('Sign in');
  assert.equal(h.events.length, 1);
  assert.ok(h.render().some((node) => node.props?.children === 'Email or password is incorrect.'));
});

 test('email login starts as a compact disclosure and expands the form', () => {
   let h = loadLogin('ios');
   assert.equal(h.input('Email'), undefined);
   let label = h.render().find((node) => node.type === 'Text' && node.props.children === 'Sign in with email');
   assert.equal(label.props.style.fontSize, 13);
   h.press('Sign in with email');
   assert.ok(h.input('Email'));
   h.press('Sign in with email');
   assert.equal(h.input('Email'), undefined);
 });
