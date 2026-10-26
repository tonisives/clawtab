const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const ts = require("typescript");

test("Google sign-in uses a client whose callback is registered by the native build", () => {
  const root = path.resolve(__dirname, "..");
  const file = path.join(root, "src/lib/googleIosClientId.ts");
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: createRequire(file),
    process: { env: { EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS: "stale-client.apps.googleusercontent.com" } },
  });
  const config = JSON.parse(execFileSync(process.execPath, [
    require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, EXPO_NO_DOTENV: "1" } }));
  const schemes = config._internal.modResults.ios.infoPlist.CFBundleURLTypes.flatMap(type => type.CFBundleURLSchemes);
  assert.match(exports.googleIosClientId, /^[\w-]+\.apps\.googleusercontent\.com$/);
  assert.ok(schemes.includes(exports.googleIosClientId.split(".").reverse().join(".")));
});
