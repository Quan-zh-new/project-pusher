'use strict';

// A safe, offline readiness check. It deliberately never prints API keys.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const root = path.resolve(__dirname, '..');
const libraCli = process.env.LIBRA_CLI_PATH || path.join(root, '.venv-libra-cli', 'bin', 'libra-cli');

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function commandAvailable(command) {
  try { await execFileAsync(command, ['--help'], { timeout:5_000, maxBuffer:128 * 1024 }); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

async function main() {
  const checks = [
    ['Node.js 版本', Number(process.versions.node.split('.')[0]) >= 20, `当前 ${process.versions.node}（需要 20+）`],
    ['配置模板', await exists(path.join(root, '.env.example')), '.env.example'],
    ['本地配置', await exists(path.join(root, '.env')), '.env（可选；配置真实 AI 时需要）'],
    ['OpenRouter API Key', Boolean(process.env.OPENROUTER_API_KEY), '仅检查是否已设置，不显示密钥'],
    ['lark-cli', await commandAvailable('lark-cli'), '用于飞书文档/云盘；可选'],
    ['libra-cli', await exists(libraCli), `${libraCli}（可选）`],
  ];
  let failures = 0;
  console.log('\nProject Pusher readiness check\n');
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✓' : '○'} ${name}: ${detail}`);
    if (name === 'Node.js 版本' && !ok) failures += 1;
  }
  console.log('\n○ 表示可选能力尚未配置；应用仍可用演示模式启动。');
  if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(`自检失败：${error.message}`); process.exitCode = 1; });
