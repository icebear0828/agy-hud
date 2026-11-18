import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('repository contracts', () => {
  test('install, uninstall, and skill docs reference valid paths and commands', () => {
    const installSh = read('scripts/install.sh');
    const installPs1 = read('scripts/install.ps1');
    const uninstallSh = read('uninstall.sh');
    const uninstallPs1 = read('uninstall.ps1');
    const skillHud = read('skills/hud/SKILL.md');
    const skillCfg = read('skills/hud-config/SKILL.md');
    const readme = read('README.md');
    const readmeZh = read('README_zh.md');

    assert.match(installSh, /icebear0828\/agy-hud/);
    assert.match(installSh, /22.*18|18.*22/);
    assert.match(installSh, /AGY_HUD_SETUP_SOURCE_DIR/);
    assert.match(installPs1, /icebear0828\/agy-hud/);
    assert.match(installPs1, /22.*18|18.*22/);
    assert.match(installPs1, /AGY_HUD_SETUP_SOURCE_DIR/);
    assert.match(uninstallSh, /uninstall\.mjs/);
    assert.match(uninstallPs1, /uninstall\.mjs/);
    assert.match(skillHud, /doctor/);
    assert.match(skillHud, /preview/);
    assert.match(skillHud, /schema/);
    assert.match(skillCfg, /hud\.mjs/);
    assert.match(readme, /scripts\/install\.sh/);
    assert.match(readmeZh, /scripts\/install\.sh/);

    // PowerShell scripts piped through `irm ... | iex` fail if they carry a UTF-8 BOM (0xEF 0xBB 0xBF)
    // or non-ASCII bytes under legacy Windows PowerShell codepages, or unescaped " inside `node -e '...'`.
    for (const psRel of ['scripts/install.ps1', 'uninstall.ps1']) {
      const raw = fs.readFileSync(path.join(root, psRel));
      assert.ok(
        !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf),
        `${psRel} must NOT have a UTF-8 BOM (breaks irm ... | iex)`,
      );
      for (let i = 0; i < raw.length; i++) {
        assert.ok(raw[i] <= 0x7f, `${psRel} contains non-ASCII byte 0x${raw[i].toString(16)} at offset ${i}`);
      }
    }
    assert.doesNotMatch(installPs1, /node\s+-e\s+'[^']*"[^']*'/);
  });

  test('every file in runtime/ is listed in scripts/bootstrap.js RUNTIME_FILES and no RUNTIME_FILES entry is gitignored', async () => {
    const { execFileSync } = await import('node:child_process');
    const { RUNTIME_FILES } = await import('../scripts/bootstrap.js');
    const bootstrap = read('scripts/bootstrap.js');
    const files = fs.readdirSync(path.join(root, 'runtime'), { recursive: true })
      .map((f) => `runtime/${f.replace(/\\/g, '/')}`)
      .filter((f) => fs.statSync(path.join(root, f)).isFile());
    for (const rel of files) {
      assert.ok(bootstrap.includes(`'${rel}'`), `${rel} is missing from scripts/bootstrap.js RUNTIME_FILES`);
    }
    if (fs.existsSync(path.join(root, '.git'))) {
      let ignored = '';
      try {
        ignored = execFileSync('git', ['check-ignore', ...RUNTIME_FILES], { cwd: root, encoding: 'utf8' });
      } catch (err) {
        if (err.status !== 1) throw err; // git check-ignore exits 1 when NO files are ignored
      }
      assert.equal(ignored.trim(), '', `RUNTIME_FILES entries are gitignored and would 404 on online install:\n${ignored}`);
    }
  });
});
