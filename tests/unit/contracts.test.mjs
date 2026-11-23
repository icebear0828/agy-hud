import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function extractConfigurationJson(readme, headingPattern) {
  const normalizedReadme = readme.replace(/\r\n/g, '\n');
  const match = normalizedReadme.match(new RegExp(`${headingPattern}[\\s\\S]*?\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  assert.ok(match, 'README must include a JSON configuration example');
  return JSON.parse(match[1]);
}

test('release manifests keep the same package version', () => {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const geminiExtension = readJson('gemini-extension.json');

  assert.equal(geminiExtension.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
});

test('README configuration examples match supported runtime fields', () => {
  const configs = [
    extractConfigurationJson(readText('README.md'), '## Configuration'),
    extractConfigurationJson(readText('README_zh.md'), '## 配置'),
  ];

  for (const config of configs) {
    assert.equal(config.display.unicode, undefined);
    assert.equal(config.display.nerdFont, undefined);
    assert.equal(typeof config.display.useNerdFonts, 'boolean');
    assert.equal(config.thresholds.warning, 0.7);
    assert.equal(config.thresholds.critical, 0.9);
  }
});

test('CI uses reproducible install and scheduled agy drift checks', () => {
  const workflow = readText('.github/workflows/e2e.yml');

  assert.match(workflow, /^\s+schedule:/m);
  assert.match(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24:\s*'true'/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|upload-artifact)@v4/);
  assert.match(workflow, /npm ci/);
  assert.doesNotMatch(workflow, /npm install/);
});

test('CI E2E detection follows the current brandless HUD layout', () => {
  const releaseScript = readText('release.sh');
  const workflow = readText('.github/workflows/e2e.yml');
  const verifyDisplay = readText('scripts/verify-display.js');

  assert.doesNotMatch(releaseScript, /assert AGY-HUD/);
  assert.doesNotMatch(releaseScript, /AGY-HUD rendered/);
  assert.doesNotMatch(workflow, /AGY-HUD banner/);
  assert.doesNotMatch(verifyDisplay, /AGY-HUD banner/);
  assert.doesNotMatch(verifyDisplay, /literal AGY-HUD/);
  assert.doesNotMatch(verifyDisplay, /includes\('AGY-HUD'\)/);
  assert.doesNotMatch(verifyDisplay, /\/AGY-HUD\//);
  assert.match(verifyDisplay, /detectHudRender/);
});

test('configure-utf8 script fails loudly and is covered by Windows CI', () => {
  const script = readText('scripts/configure-utf8.ps1');
  const workflow = readText('.github/workflows/e2e.yml');

  assert.match(script, /\$ErrorActionPreference\s*=\s*'Stop'/);
  assert.match(script, /function Invoke-CheckedCommand/);
  assert.match(script, /Get-Command git/);
  assert.match(script, /\$env:AGY_HUD_PROFILE_PATH/);
  assert.match(script, /\$LASTEXITCODE/);

  assert.match(workflow, /Test configure-utf8 script \(Windows\)/);
  assert.match(workflow, /GIT_CONFIG_GLOBAL/);
  assert.match(workflow, /AGY_HUD_PROFILE_PATH/);
});

test('release script prints valid GitHub release install URLs', () => {
  const releaseScript = readText('release.sh');

  assert.match(releaseScript, /replace\(\/\\\.git\$\/,\s*''\)/);
  assert.doesNotMatch(releaseScript, /replace\(\/\\\.git\\\$\/,\s*''\)/);
});

test('Windows installer fails loudly when native plugin install fails', () => {
  const installScript = readText('scripts/install.ps1');
  const installIndex = installScript.indexOf('agy plugin install $RepoUrl');
  const bootstrapIndex = installScript.indexOf('$BootstrapUrl');

  assert.notEqual(installIndex, -1);
  assert.notEqual(bootstrapIndex, -1);
  assert.match(
    installScript.slice(installIndex, bootstrapIndex),
    /\$LASTEXITCODE\s+-ne\s+0/
  );
});

test('Windows uninstaller falls back when plugin uninstall fails', () => {
  const uninstallScript = readText('uninstall.ps1');

  assert.match(uninstallScript, /\$PluginDir\s*=/);
  assert.match(uninstallScript, /Remove-Item\s+\$PluginDir/);
  assert.match(uninstallScript, /\$LASTEXITCODE\s+-ne\s+0/);
});

test('release package contract ships agent skills and gemini-extension.json', () => {
  const packageJson = readJson('package.json');
  const releaseScript = readText('release.sh');
  const workflow = readText('.github/workflows/e2e.yml');

  assert.deepEqual(packageJson.files, [
    'runtime',
    'scripts',
    'skills',
    'plugin.json',
    'gemini-extension.json',
    'README.md',
    'package.json',
  ]);
  assert.match(releaseScript, /skills/);
  assert.match(workflow, /cp -r skills release_tmp\//);
  assert.match(workflow, /Copy-Item -Recurse runtime,scripts,skills release_tmp\\/);
  assert.ok(
    fs.existsSync(path.join(projectRoot, 'skills', 'hud-config', 'SKILL.md')),
    'skills/hud-config/SKILL.md must exist so the agent can load the config skill'
  );
});

test('install.sh and bootstrap.sh use mktemp + trap instead of <(curl ...) process substitution', () => {
  for (const rel of ['scripts/install.sh', 'scripts/bootstrap.sh']) {
    const script = readText(rel);
    const codeLines = script
      .split(/\r?\n/)
      .filter(line => !/^\s*#/.test(line))
      .join('\n');
    assert.doesNotMatch(codeLines, /<\(curl/, `${rel} must not use <(curl ...) process substitution`);
    assert.match(codeLines, /mktemp/, `${rel} must stage bootstrap.js in a temp file`);
    assert.match(codeLines, /trap\s+'rm -f "\$TMP_BOOTSTRAP"'\s+EXIT/, `${rel} must clean up temp file on EXIT`);
    assert.match(codeLines, /curl -fsSL .* -o "\$TMP_BOOTSTRAP"/, `${rel} must fail on curl error`);
  }
});

test('release.sh handles E2E exit codes under set -e and separates stderr from JSON report', () => {
  const releaseScript = readText('release.sh');
  assert.match(releaseScript, /set \+e[\s\S]*verify-display\.js[\s\S]*E2E_RC=\$\?[\s\S]*set -e/);
  assert.doesNotMatch(releaseScript, /> \/tmp\/release-e2e\.json 2>&1/);
  assert.match(releaseScript, /> \/tmp\/release-e2e\.json 2> \/tmp\/release-e2e\.stderr/);
});

test('package does not keep obsolete local HTTP server helpers', () => {
  const packageJson = readJson('package.json');

  assert.equal(packageJson.scripts['serve:release'], undefined);
  assert.equal(packageJson.scripts['serve:source'], undefined);
  assert.equal(fs.existsSync(path.join(projectRoot, 'scripts', 'serve-release.js')), false);
  assert.equal(fs.existsSync(path.join(projectRoot, 'scripts', 'serve-source.js')), false);
});
