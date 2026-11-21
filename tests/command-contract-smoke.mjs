import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
const commands = [...new Set([...app.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]))].sort();
const handler = rust.match(/generate_handler!\s*\[([\s\S]*?)\]\s*\)/)?.[1];

if (!handler) throw new Error('Could not find the Tauri command handler');
if (!commands.length) throw new Error('No frontend invoke commands were found');

for (const command of commands) {
  if (!new RegExp(`(?:async\\s+)?fn\\s+${command}\\b`).test(rust)) {
    throw new Error(`Frontend command has no Rust implementation: ${command}`);
  }
  if (!new RegExp(`\\b${command}\\b`).test(handler)) {
    throw new Error(`Frontend command is not registered in generate_handler!: ${command}`);
  }
}

console.log(JSON.stringify({ frontendCommands: commands.length, allImplemented: true, allRegistered: true }));
