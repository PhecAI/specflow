#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const scriptDir = __dirname;
const pluginRoot = path.resolve(scriptDir, '..');
const pluginName = 'specflow';

const homeDir = os.homedir();
if (!homeDir) {
  fail('无法解析用户 Home 目录，安装中止。');
}

if (!fs.existsSync(path.join(pluginRoot, '.cursor-plugin', 'plugin.json'))) {
  fail('未找到 .cursor-plugin/plugin.json，请确认在插件仓库根目录执行。');
}

const localPluginsDir = path.join(homeDir, '.cursor', 'plugins', 'local');
const targetPath = path.join(localPluginsDir, pluginName);

fs.mkdirSync(localPluginsDir, { recursive: true });

if (fs.existsSync(targetPath)) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  log(`已覆盖旧目录：${targetPath}`);
}

fs.cpSync(pluginRoot, targetPath, {
  recursive: true,
  force: true,
  dereference: true,
});

log('安装完成。');
log(`插件路径：${pluginRoot}`);
log(`安装目录：${targetPath}`);
log('请在 Cursor 执行：Developer: Reload Window');
