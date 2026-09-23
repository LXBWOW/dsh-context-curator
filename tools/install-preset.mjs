/**
 * Install the preset that swaps DSH's compaction summarizer for this plugin.
 *
 * WHY A PRESET COPY RATHER THAN A PATCH: a preset's rows resolve bare package
 * names from the harness's own node_modules, and `dsh-agent-presets` has no
 * "patch one row of a shipped preset" mechanism — its own README says so
 * ("本层也没有表达「standard 加一处改动」的 patch 语义"). A preset is authored by
 * COPYING one and editing it, which is what this script does. The cost is the
 * documented one: the copy is a snapshot and later harness upgrades do not flow
 * into it. Re-run this script after an upgrade to refresh the copy.
 *
 *   node tools/install-preset.mjs            # install or refresh
 *   node tools/install-preset.mjs --check    # report what is installed
 *   node tools/install-preset.mjs --print    # show the composed file, write nothing
 *
 * The plugin is referenced by ABSOLUTE PATH, not by package name: a bare name
 * would have to resolve from the harness's node_modules, and this plugin lives
 * in a git checkout. `PresetTree.import()` turns an absolute path into a file
 * URL, which is the supported way to name a file that travels with neither the
 * preset nor the harness.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const pluginEntry = join(pluginRoot, 'lib', 'index.js');

const PRESET_ID = 'context-curator';
const PRESET_NAME = '标准模式 + 上下文整理（Jev）';
const PRESET_DESCRIPTION =
  '标准模式的完整装配，只把压缩摘要换成 Jev 逐条判断：过期的工具输出被删掉，其余内容逐字保留。默认 shadow（只记录不采用）。';

/** Candidate locations of the shipped `standard` preset. */
function candidateSources() {
  const fromEnv = process.env.DSH_STANDARD_PRESET_DIR;
  const candidates = [];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) candidates.push(fromEnv.trim());
  const appDirs = [
    process.env.DSH_APP_DIR,
    'C:/Program Files/DSH Desktop/resources/app',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DSH Desktop/resources/app'),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const app of appDirs) {
    candidates.push(join(app, 'node_modules/@deepseek-ai/dsh-agent-presets/presets/standard'));
  }
  return candidates;
}

function findSource() {
  for (const candidate of candidateSources()) {
    if (existsSync(join(candidate, 'agent.cordis.yml'))) return candidate;
  }
  return null;
}

const args = new Set(process.argv.slice(2));
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const presetDir = join(dshHome, '.agent-presets', PRESET_ID);
const presetPath = join(presetDir, 'agent.cordis.yml');
const metaPath = join(presetDir, 'preset.yml');

/** The row that replaces `compaction-basic`, at the same nesting depth. */
function composited(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^- id: compaction-basic\s*$/.test(line.trim()) || /^\s*- id: compaction-basic\s*$/.test(line)) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      out.push(`${indent}- id: ${PRESET_ID}`);
      const nameLine = lines[index + 1];
      if (nameLine === undefined || !/name:/.test(nameLine)) {
        throw new Error('the shipped preset changed shape: compaction-basic has no name row');
      }
      out.push(`${indent}  name: '${pluginEntry.replace(/\\/g, '/')}'`);
      out.push(`${indent}  config:`);
      out.push(`${indent}    adopt: false`);
      index += 1;
      replaced = true;
      continue;
    }
    out.push(line);
  }
  if (!replaced) throw new Error('the shipped preset no longer contains a compaction-basic row to replace');
  const banner = [
    '# Installed by dsh-context-curator tools/install-preset.mjs from the shipped "standard" preset.',
    '# The ONLY change is the compaction row inside the "compaction" group:',
    '#   - id: compaction-basic / name: @deepseek-ai/dsh-compaction-basic',
    '# became this plugin, referenced by absolute path so it resolves from a checkout.',
    '# Everything else is the shipped composition, copied verbatim — re-run the script after',
    '# a harness upgrade to refresh it (preset copies do not track upgrades on their own).',
    '# To disable: set `adopt: false` (shadow) or remove this preset and use 标准模式.',
    '',
  ].join('\n');
  return `${banner}${out.join('\n')}`;
}

const source = findSource();
if (source === null) {
  console.error('could not find the shipped "standard" preset; set DSH_STANDARD_PRESET_DIR to its directory');
  process.exitCode = 1;
} else {
  const body = composited(readFileSync(join(source, 'agent.cordis.yml'), 'utf8'));

  if (args.has('--print')) {
    console.log(body.split('\n').slice(0, 12).join('\n'));
    console.log(`...\n(${body.split('\n').length} lines total)`);
  } else if (args.has('--check')) {
    console.log(`source preset : ${source}`);
    console.log(`preset dir    : ${presetDir} (${existsSync(presetPath) ? 'installed' : 'MISSING'})`);
    if (existsSync(presetPath)) {
      const installed = readFileSync(presetPath, 'utf8');
      console.log(`points at     : ${installed.includes(pluginEntry.replace(/\\/g, '/')) ? pluginEntry : 'a different path'}`);
      console.log(`matches source: ${installed.slice(installed.indexOf('- id:')) === body.slice(body.indexOf('- id:')) ? 'yes' : 'no — re-run to refresh'}`);
    }
    console.log(`plugin entry  : ${pluginEntry} (${existsSync(pluginEntry) ? 'present' : 'MISSING'})`);
  } else {
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(presetPath, body, 'utf8');
    writeFileSync(
      metaPath,
      `name: ${PRESET_NAME}\ndescription: ${PRESET_DESCRIPTION}\norder: 90\n`,
      'utf8',
    );
    console.log(`wrote ${presetPath}`);
    console.log(`wrote ${metaPath}`);
    console.log(`plugin entry: ${pluginEntry}`);
    console.log('');
    console.log('Next: start a session on the new preset in DSH (it appears as "' + PRESET_NAME + '"),');
    console.log('then run /curator after the first compaction. It starts in shadow mode.');
    console.log(`preset URL for reference: ${pathToFileURL(presetPath).href}`);
  }
}
