#!/usr/bin/env node
'use strict';

// Published CLI entry point. Configuration lives outside the npm cache, so a
// later `npx @quanhongzhang/project-pusher@latest` update keeps the user's workspace.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const packageRoot = path.resolve(__dirname, '..');
const appHome = process.env.PROJECT_PUSHER_HOME || path.join(os.homedir(), '.project-pusher');
const configPath = path.join(appHome, 'config.json');
const dataDir = path.join(appHome, 'data');

function print(message = '') { process.stdout.write(`${message}\n`); }
function validCliName(value) { return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value); }
function validPipPackage(value) { return /^[A-Za-z0-9][A-Za-z0-9_.-]*(\[[A-Za-z0-9_,.-]+\])?(==[A-Za-z0-9_.+-]+)?$/.test(value); }
function parsePipInstallInput(value) {
  const input = String(value || '').trim();
  if (validPipPackage(input)) return input;
  const matched = input.match(/^(?:python3|python)\s+-m\s+pip\s+install\s+([A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:==[A-Za-z0-9_.+-]+)?)$/);
  if (matched) return matched[1];
  throw new Error('仅支持 PyPI 包名，或安全格式的「python3 -m pip install <包名>」。不支持 URL、--index-url 或其他安装参数。');
}
function prompt(question, { secret=false } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input:process.stdin, output:process.stdout });
    if (!secret) return rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    process.stdout.write(question);
    let answer = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      for (const char of text) {
        if (char === '\n' || char === '\r') {
          process.stdin.off('data', onData); process.stdin.setRawMode?.(false); rl.close(); print(); return resolve(answer.trim());
        }
        if (char === '\u0003') { process.exitCode = 130; process.exit(); }
        if (char === '\u007f') answer = answer.slice(0, -1); else answer += char;
      }
    };
    rl.pause(); process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}
async function readConfig() {
  try { return { clis:[], ...JSON.parse(await fs.readFile(configPath, 'utf8')) }; } catch { return null; }
}
async function writeConfig(config) {
  await fs.mkdir(appHome, { recursive:true, mode:0o700 });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode:0o600 });
  await fs.chmod(configPath, 0o600);
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)));
  });
}
async function installCliFromPip(config, pipPackage) {
  pipPackage = parsePipInstallInput(pipPackage);
  print(`安装 Python CLI：${pipPackage}`);
  await run('python3', ['-m', 'pip', 'install', pipPackage]);
  const lookup = "import importlib.metadata as m, sys\ntry:\n d=m.distribution(sys.argv[1]); print('\\n'.join(e.name for e in d.entry_points if e.group == 'console_scripts'))\nexcept Exception as e: raise SystemExit(str(e))";
  const commands = (await capture('python3', ['-c', lookup, pipPackage])).trim().split(/\r?\n/).filter(Boolean);
  if (!commands.length) throw new Error(`已安装 ${pipPackage}，但它没有可执行 CLI。请仅安装提供命令行入口的 PyPI 包。`);
  const normalized = pipPackage.replace(/[-_.]/g, '').toLowerCase();
  const executable = commands.find((item) => item.replace(/[-_.]/g, '').toLowerCase() === normalized) || commands[0];
  config.clis = (config.clis || []).filter((item) => item.name !== executable);
  config.clis.push({ name:executable, executable, capabilities:`由 PyPI 包 ${pipPackage} 自动安装和识别的 CLI。` });
  await writeConfig(config);
  print(`已安装并接入「${executable}」。`);
}
async function addCli(config, supplied = {}) {
  const name = supplied.name || await prompt('CLI 名称（例如 github）: ');
  if (!validCliName(name)) throw new Error('CLI 名称只能包含字母、数字、- 和 _。');
  const pipPackage = supplied.pipPackage ?? await prompt('pip3 包名（可留空，仅登记已有 CLI）: ');
  if (pipPackage) {
    // The explicit advanced command preserves a caller-provided alias; the
    // simple `cli install` command below needs no alias or executable input.
    if (!validPipPackage(pipPackage)) throw new Error('为安全起见，pip 包名不能包含 URL、空格或安装参数。');
    print(`安装 Python 包：${pipPackage}`); await run('python3', ['-m', 'pip', 'install', pipPackage]);
  }
  const executable = supplied.executable || await prompt(`可执行命令（默认 ${name}）: `) || name;
  if (/[\0\r\n]/.test(executable)) throw new Error('可执行命令格式无效。');
  const capabilities = supplied.capabilities ?? await prompt('它能做什么（可选）: ');
  config.clis = (config.clis || []).filter((item) => item.name !== name);
  config.clis.push({ name, executable, capabilities });
  await writeConfig(config);
  print(`已登记 CLI「${name}」。AI 会先读取 --help，再按你确认的参数执行。`);
}
async function onboard(existing = null) {
  if (!process.stdin.isTTY) throw new Error('首次配置需要交互终端。请在终端运行：npx @quanhongzhang/project-pusher@latest setup');
  const config = existing || { version:1, port:4173, clis:[] };
  print('\nProject Pusher 初始配置（所有配置仅保存在当前用户目录）\n');
  const mode = await prompt('启动模式 [1] 演示（默认） [2] 真实 AI: ');
  config.demoMode = mode !== '2';
  if (!config.demoMode) {
    const key = await prompt('OpenRouter API Key: ', { secret:true });
    if (key) config.openrouterApiKey = key;
    config.openrouterModel = await prompt(`模型 ID（留空使用默认 ${config.openrouterModel || 'deepseek/deepseek-v4-pro-0813'}）: `) || config.openrouterModel || 'deepseek/deepseek-v4-pro-0813';
  }
  const port = await prompt(`端口（默认 ${config.port || 4173}）: `);
  if (port) { if (!/^\d{2,5}$/.test(port) || Number(port) > 65535) throw new Error('端口无效。'); config.port = Number(port); }
  await writeConfig(config);
  return config;
}
function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached:true, stdio:'ignore' }); child.unref();
}
async function waitForHealth(port) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal:AbortSignal.timeout(800) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
async function start(config, { open=true } = {}) {
  await fs.mkdir(dataDir, { recursive:true, mode:0o700 });
  const port = Number(config.port || 4173);
  const env = {
    ...process.env, PORT:String(port), HOST:'127.0.0.1', PROJECT_PUSHER_DATA_DIR:dataDir,
    PROJECT_PUSHER_CLI_REGISTRY:JSON.stringify(config.clis || []),
    DEMO_MODE:config.demoMode ? 'true' : 'false',
  };
  if (config.openrouterApiKey) env.OPENROUTER_API_KEY = config.openrouterApiKey;
  if (config.openrouterModel) env.OPENROUTER_MODEL = config.openrouterModel;
  print(`\n正在启动 Project Pusher：http://127.0.0.1:${port}`);
  const child = spawn(process.execPath, ['--use-env-proxy', path.join(packageRoot, 'server.js')], { env, stdio:'inherit' });
  if (open) void waitForHealth(port).then((ready) => ready ? openBrowser(`http://127.0.0.1:${port}`) : print('服务未在预期时间内就绪；请检查上方日志。'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => { process.exitCode = code || 0; });
}
async function doctor() {
  const config = await readConfig();
  print('\nProject Pusher CLI doctor\n');
  print(`${Number(process.versions.node.split('.')[0]) >= 20 ? '✓' : '!' } Node.js ${process.versions.node}（需要 20+）`);
  print(`${config ? '✓' : '○'} 用户配置：${config ? configPath : '未配置；运行 project-pusher setup'}`);
  if (config) { print(`${config.demoMode ? '✓ 演示模式' : config.openrouterApiKey ? '✓ OpenRouter API 已配置' : '! 未配置 OpenRouter API'}`); print(`✓ 已登记 ${config.clis?.length || 0} 个外部 CLI`); }
}
function help() { print(`\nProject Pusher\n\n  npx @quanhongzhang/project-pusher@latest          首次配置并启动\n  npx @quanhongzhang/project-pusher@latest setup    重新配置\n  npx @quanhongzhang/project-pusher@latest start    使用保存的配置启动\n  npx @quanhongzhang/project-pusher@latest doctor   检查本机状态\n  npx @quanhongzhang/project-pusher@latest cli install <PyPI包名或pip安装命令>\n  npx @quanhongzhang/project-pusher@latest cli add <name> [--pip package] [--command executable]  高级模式\n`); }
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更高版本。');
  const [command, ...args] = process.argv.slice(2);
  if (['-h', '--help', 'help'].includes(command)) return help();
  if (command === 'doctor') return doctor();
  let config = await readConfig();
  if (command === 'setup') { config = await onboard(config); return start(config); }
  if (command === 'cli' && args[0] === 'add') {
    config ||= await onboard();
    const pipIndex=args.indexOf('--pip'), commandIndex=args.indexOf('--command');
    await addCli(config, { name:args[1], pipPackage:pipIndex >= 0 ? args[pipIndex + 1] : '', executable:commandIndex >= 0 ? args[commandIndex + 1] : '' }); return;
  }
  if (command === 'cli' && args[0] === 'install') {
    config ||= await onboard();
    const pipInput=args.slice(1).join(' ');
    if (!pipInput) throw new Error('请提供 PyPI 包名或 pip 安装命令，例如：project-pusher cli install "python3 -m pip install httpie"');
    await installCliFromPip(config, pipInput); return;
  }
  if (!config) config = await onboard();
  return start(config, { open:command !== 'start' || !args.includes('--no-open') });
}
main().catch((error) => { process.stderr.write(`\n启动失败：${error.message}\n`); process.exitCode = 1; });
