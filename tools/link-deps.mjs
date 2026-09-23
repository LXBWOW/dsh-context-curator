/**
 * Link the two packages this plugin imports but must not vendor.
 *
 * WHY THIS EXISTS: this plugin is loaded by an AGENT PRESET, and a preset's rows
 * resolve bare package names from the harness's own node_modules — never from
 * the checkout the plugin lives in. So the plugin's own imports (`schemastery`
 * and `@deepseek-ai/dsh-compaction-basic`, the class it subclasses) need a
 * node_modules beside it that points at the installed harness.
 *
 * Junctions, not copies: an upgrade of DSH then updates what this plugin loads
 * with no re-run. Junctions also need no administrator rights on Windows.
 *
 *   node tools/link-deps.mjs            # create what is missing
 *   node tools/link-deps.mjs --check    # report only
 *   node tools/link-deps.mjs --remove   # undo (deletes the junctions, never the targets)
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const nodeModules = join(pluginRoot, 'node_modules');

/** package name -> the directory that must exist for it to resolve. */
const WANTED = ['schemastery', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/cordis'];

/** Where the installed harness keeps its own dependencies. */
function harnessRoots() {
  const roots = [];
  if (typeof process.env.DSH_APP_DIR === 'string' && process.env.DSH_APP_DIR.length > 0) {
    roots.push(process.env.DSH_APP_DIR);
  }
  roots.push('C:/Program Files/DSH Desktop/resources/app');
  // The host-plane plugins resolve from the profile, which pnpm fills; that is
  // where a package the harness itself does not carry (schemastery, today) lives.
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');
  roots.push(join(home, 'profiles', 'desktop'));
  return roots;
}

function findTarget(name) {
  for (const root of harnessRoots()) {
    const candidate = join(root, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

const args = new Set(process.argv.slice(2));
const removing = args.has('--remove');
const checking = args.has('--check');
let failures = 0;

for (const name of WANTED) {
  const link = join(nodeModules, name);
  const target = findTarget(name);
  if (checking) {
    console.log(`${existsSync(link) ? 'ok     ' : 'MISSING'} ${name}`);
    if (target === null) {
      console.log(`        no installed copy found in: ${harnessRoots().join(', ')}`);
      failures += 1;
    }
    continue;
  }
  if (removing) {
    if (existsSync(link)) {
      rmSync(link, { recursive: true, force: true });
      console.log(`removed ${link}`);
    }
    continue;
  }
  if (target === null) {
    console.error(`cannot link ${name}: no installed copy found`);
    failures += 1;
    continue;
  }
  if (existsSync(link)) {
    console.log(`already linked: ${name}`);
    continue;
  }
  mkdirSync(dirname(link), { recursive: true });
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
    console.log(`linked ${name} -> ${target}`);
  } catch (error) {
    console.error(`could not create the junction for ${name}: ${String(error?.message ?? error)}`);
    failures += 1;
  }
}

if (failures > 0) process.exitCode = 1;
else if (!checking && !removing) {
  const require = createRequire(join(pluginRoot, 'package.json'));
  try {
    require.resolve('schemastery');
    console.log('resolution check: ok');
  } catch {
    console.log('resolution check: schemastery still does not resolve');
    process.exitCode = 1;
  }
}
