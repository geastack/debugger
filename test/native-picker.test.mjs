import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeApp = process.env.GEA_DEBUGGER_NATIVE_TEST_EXECUTABLE
test('native picker consumes the complete gesture and releases input on cancel/disconnect', {
  skip: process.platform !== 'darwin' || !nativeApp,
}, () => {
  // Use the app's existing ignored build output, alongside its native objects.
  const executable = path.resolve(path.dirname(nativeApp), '../../../build/debugger-picker-test')
  const source = '#include <cstdio>\n#include <cstdlib>\n' +
    `#include ${JSON.stringify(fileURLToPath(new URL('../native/macos-picker.h', import.meta.url)))}\n` +
    readFileSync(new URL('./native-picker.mm', import.meta.url), 'utf8')
  execFileSync('clang++', ['-std=c++20', '-fobjc-arc', '-x', 'objective-c++', '-',
    '-framework', 'AppKit', '-o', executable], { input: source, stdio: ['pipe', 'inherit', 'inherit'] })
  execFileSync(executable, { stdio: 'inherit' })
})
