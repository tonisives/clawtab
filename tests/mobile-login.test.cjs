const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let loadLogin = (os, params = {}) => {
  let events = [], browserRequests = 0, configured;
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
  let auth = { googleLogin: async (token) => events.push(['login', token]), appleLogin: async () => {} };
  let login = load(require.resolve('../remote/app/login.tsx'), {
    react: { useState: (initial) => [initial, () => {}], useCallback: (fn) => fn, useEffect: () => {} },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: os }, StyleSheet: { create: (value) => value },
      View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Modal: 'Modal', Image: 'Image' },
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
  let nodes = all(login.default());
  let press = (label) => nodes.find((node) => node.type === 'Pressable'
    && all(node).some((child) => child.type === 'Text' && child.props.children === label)).props.onPress();
  return { events, configured, browserRequests, press };
};

for (let os of ['android', 'ios', 'web']) {
  test(`${os} login renders, opens demo, and completes Google sign-in using its platform flow`, async () => {
    let h = loadLogin(os);
    assert.equal(h.browserRequests, os === 'web' ? 1 : 0);
    if (os !== 'web') assert.equal(h.configured.webClientId, 'web-client');
    h.press('Try demo');
    assert.equal(h.events[0][1], '/demo');
    await h.press('Sign in with Google');
    assert.deepEqual(h.events.slice(1), [['login', os === 'web' ? 'web-identity' : 'native-identity'], ['replace', '/(tabs)']]);
  });
}

test('sign-in preserves the selected demo setup path', async () => {
  for (let os of ['ios', 'web']) for (let destination of ['add-machine', 'account']) {
    let h = loadLogin(os, { return_to: destination });
    await h.press('Sign in with Google');
    assert.deepEqual(h.events.at(-1), ['replace', `/${destination}`]);
  }
});
