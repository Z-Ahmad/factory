import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ConfigError, load, parseToml, toEnvSh } from '../cmd/config.mjs';
import { factory, fixture } from './helpers.mjs';

const parse = (text) => parseToml(text).data;
const syntaxError = (text) => {
  try {
    parseToml(text);
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e}`);
    return e;
  }
  assert.fail('expected a syntax error');
};

// ---- parser ---------------------------------------------------------

test('parser: scalars, comments and quoted keys', () => {
  const d = parse(`
    # leading comment
    s = "a \\"b\\" \\u00e9"   # trailing comment
    lit = 'C:\\raw'
    i = 1_000
    neg = -3
    f = 4.5
    t = true
    f2 = false
    "quoted key/with.dot" = 1
  `);
  assert.deepEqual(d, {
    s: 'a "b" é',
    lit: 'C:\\raw',
    i: 1000,
    neg: -3,
    f: 4.5,
    t: true,
    f2: false,
    'quoted key/with.dot': 1,
  });
});

test('parser: a # inside a string is not a comment', () => {
  assert.equal(parse('k = "a # b"').k, 'a # b');
});

test('parser: arrays, multi-line with comments and trailing comma', () => {
  const d = parse(`
    a = [1, 2,3]
    b = [
      "x",   # one
      "y",
    ]
    c = []
    d = [ [1], [2, 3] ]
  `);
  assert.deepEqual(d, { a: [1, 2, 3], b: ['x', 'y'], c: [], d: [[1], [2, 3]] });
});

test('parser: inline tables, nested, with arrays', () => {
  const d = parse('k = { a = 1, "b c" = "x", n = { z = [true] }, e = {} }');
  assert.deepEqual(d.k, { a: 1, 'b c': 'x', n: { z: [true] }, e: {} });
});

test('parser: tables and dotted headers', () => {
  const d = parse('[a.b]\nx = 1\n[a.c]\ny = 2\n[a]\nz = 3');
  assert.deepEqual(d, { a: { b: { x: 1 }, c: { y: 2 }, z: 3 } });
});

test('parser: arrays of tables, with sub-tables', () => {
  const d = parse('[[t]]\nn = 1\n[t.sub]\nk = "a"\n[[t]]\nn = 2\n');
  assert.deepEqual(d, { t: [{ n: 1, sub: { k: 'a' } }, { n: 2 }] });
});

test('parser: CRLF line endings', () => {
  assert.deepEqual(parse('a = 1\r\n[t]\r\nb = "x"\r\n'), { a: 1, t: { b: 'x' } });
});

test('parser: records the line of every key', () => {
  const { lines } = parseToml('a = 1\n\n[t]\nb = 2\n[[u]]\nc = 3\n');
  assert.equal(lines.get('a'), 1);
  assert.equal(lines.get('t'), 3);
  assert.equal(lines.get('t.b'), 4);
  assert.equal(lines.get('u.0.c'), 6);
});

test('parser errors name the line', () => {
  const cases = [
    ['a = 1\nb = \n', 2, /expected a value/],
    ['a = 1; b = 2', 1, /one key = value per line/],
    ['a = "open', 1, /unterminated string/],
    ['a = [1, 2', 1, /unterminated array/],
    ['a = { x = 1,\ny = 2 }', 1, /same line/],
    ['a = 1\na = 2', 2, /duplicate key 'a'/],
    ['[t]\n[t]', 2, /defined twice/],
    ['a.b = 1', 1, /dotted keys/],
    ['a = """x"""', 1, /multi-line strings/],
    ['a = 2020-01-01', 1, /unexpected '-'/],
    ['[t', 1, /expected '\]'/],
    ['[x.y.z]\n[x.y]\n[x.y]', 3, /defined twice/],
    ['[x]\ny = 1\n[x.y.z]', 3, /already defined as a value/],
    ['a = 1\n[a]', 2, /already defined as a value/],
    ['a = [1]\n[[a]]', 2, /already defined as an array of values/],
    ['[[a]]\n[a]', 2, /cannot redefine array of tables/],
    ['= 1', 1, /expected a key/],
  ];
  for (const [text, line, re] of cases) {
    const e = syntaxError(text);
    assert.equal(e.line, line, `line for ${JSON.stringify(text)}: ${e.message}`);
    assert.match(e.message, re);
  }
});

// ---- schema + expansion ----------------------------------------------

const validText = readFileSync(fixture('valid.toml'), 'utf8');

test('valid fixture passes the schema', () => {
  const r = load(validText);
  assert.deepEqual(r.errors, []);
});

test('config placeholders and ~ are expanded; runtime placeholders are kept', () => {
  const { resolved: c } = load(validText);
  const state = `${homedir()}/example-factory`;
  assert.equal(c.project.state_dir, state);
  assert.equal(c.project.night_file, `${state}/night-{n}.md`);
  assert.equal(c.project.log_line, '{hhmm} · {id} · {sha} · {note}');
  assert.equal(c.git.worktree_branch, 'factory/{name}-wt');
  assert.equal(c.seed.fixture_dir, `${state}/fixtures/example-trip`);
  assert.equal(c.proof.ios.app, 'app/Build/Example.app');
  assert.equal(c.proof.ios.launch_env.OPEN, 'example-trip');
  assert.equal(c.proof.ios.launch_env.SIGNIN, 'demo:{password}');
  assert.equal(c.dev.read_api.cwd, '/tmp/example');
  assert.equal(c.disk.dd_root, `${homedir()}/Library/Caches/example-app`);
  assert.deepEqual(c.phone.wipe, [`${homedir()}/Library/Caches/example-app/dd-device`]);
});

test('env --sh output: scalars, lists, tables, array of tables, quoting', () => {
  const { resolved } = load(validText);
  const sh = toEnvSh(resolved, '/tmp/example/factory.toml');
  assert.match(sh, /^export FK_CONFIG='\/tmp\/example\/factory.toml'$/m);
  assert.match(sh, /^export FK_ROOT='\/tmp\/example'$/m);
  assert.match(sh, /^export FK_PROJECT_NAME='example-app'$/m);
  assert.match(sh, /^export FK_SIM_SHOOTER_UDID='00000000-0000-0000-0000-000000000000'$/m);
  assert.match(sh, /^export FK_TARGETS_COUNT='2'$/m);
  assert.match(sh, /^export FK_TARGETS_1_DEPLOYS_PROD='true'$/m);
  assert.match(sh, /^export FK_WORKTREE_CACHE_SYMLINKS='node_modules\napp\/.build'$/m);
  assert.match(sh, /^export FK_WORKTREE_NODE_MODULES='overlay'$/m);
  assert.match(sh, /^export FK_WORKTREE_COPY_FILES='site\/.env.public'$/m);
  assert.match(sh, /^export FK_WORKTREE_DERIVED_COUNT='1'$/m);
  assert.match(sh, /^export FK_WORKTREE_DERIVED_0_SOURCE='app\/src'$/m);
  assert.match(sh, /^export FK_WORKTREE_DERIVED_0_BUILD='npm run build -w app'$/m);
  assert.match(sh, /^export FK_DEV_READ_API_PORT='3002'$/m);
  assert.match(sh, /^export FK_PROOF_IOS_REST_AT_S='4.5'$/m);
  assert.match(sh, /^export FK_GIT_COMMIT_TRAILER='Co-Authored-By: Example Agent <agent@example.invalid>'$/m);
  // a single quote in a value must survive `eval`
  const quoted = toEnvSh({ project: { name: "it's" } }, '/x/factory.toml');
  assert.match(quoted, /FK_PROJECT_NAME='it'\\''s'/);
});

test('unknown keys are rejected, so typos do not pass silently', () => {
  const r = load(validText.replace('timeout_s  = 600', 'timeout_s  = 600\ntimeout = 5'));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /unknown key 'timeout' in \[dev\]/);
});

test('a placeholder that needs an unset config key is an error', () => {
  const r = load(validText.replace('trip        = "example-trip"\n', ''));
  assert.ok(r.errors.some((e) => /\{trip\} needs seed\.trip/.test(e.message)));
});

test('[worktree] node_modules must be "overlay" or "link"', () => {
  const r = load(validText.replace('node_modules   = "overlay"', 'node_modules   = "symlink"'));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, 'worktree.node_modules');
  assert.match(r.errors[0].message, /expected "overlay" or "link", got "symlink"/);
  assert.deepEqual(load(validText.replace('"overlay"', '"link"')).errors, []);
});

test('[[worktree.derived]] needs path, source and build, and rejects unknown keys', () => {
  const r = load(validText.replace('source = "app/src"\n', 'sauce = "app/src"\n'));
  const msgs = r.errors.map((e) => `${e.path}: ${e.message}`);
  assert.ok(msgs.includes("worktree.derived.0.source: missing required key 'source'"), msgs.join('\n'));
  assert.ok(msgs.some((m) => /unknown key 'sauce'/.test(m)), msgs.join('\n'));
});

test('a derived path that is also a cache symlink is an error', () => {
  const r = load(validText.replace('["node_modules", "app/.build"]', '["node_modules", "app/dist/"]'));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, 'worktree.derived.0.path');
  assert.match(r.errors[0].message, /'app\/dist' is also in \[worktree\] cache_symlinks/);
});

test('copy_files and derived paths must stay inside the checkout', () => {
  let r = load(validText.replace('["site/.env.public"]', '["../secrets/.env"]'));
  assert.equal(r.errors[0].path, 'worktree.copy_files');
  assert.match(r.errors[0].message, /relative path inside the checkout/);
  r = load(validText.replace('source = "app/src"', 'source = "/abs/src"'));
  assert.equal(r.errors[0].path, 'worktree.derived.0.source');
});

test('type errors name the key and the offending value', () => {
  const r = load(validText.replace('wait_ports = [8080, 9099]', 'wait_ports = [8080, "x"]'));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].path, 'dev.wait_ports');
  assert.match(r.errors[0].message, /element 2 is string/);
});

test('a missing required section is reported as a section', () => {
  const r = load('[kit]\nrepo = "u"\nref = "v"\n');
  const msgs = r.errors.map((e) => e.message);
  assert.ok(msgs.includes('missing required section [project]'));
  assert.ok(msgs.includes('missing required section [targets]'));
});

// ---- CLI ---------------------------------------------------------------

const cli = (file, ...args) => factory(['--file', fixture(file), 'config', ...args]);

test('cli: validate passes on the valid fixture', () => {
  const r = cli('valid.toml', 'validate');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok: /);
});

const broken = [
  ['missing-required.toml', /missing-required\.toml:1: kit\.ref: missing required key 'ref'/],
  ['wrong-type.toml', /wrong-type\.toml:22: dev\.timeout_s: expected int, got string \("600"\)/],
  ['bad-syntax.toml', /bad-syntax\.toml:6: unexpected ';' after value/],
  ['unknown-placeholder.toml', /unknown-placeholder\.toml:9: project\.night_file: unknown placeholder \{state_dri\}/],
  ['bad-array-of-tables.toml', /bad-array-of-tables\.toml:10: cannot redefine array of tables 'targets'/],
];
for (const [file, re] of broken) {
  test(`cli: validate fails clearly on ${file}`, () => {
    const r = cli(file, 'validate');
    assert.equal(r.status, 1);
    assert.match(r.stderr, re);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  });
}

test('cli: get prints scalars, lists and tables', () => {
  assert.equal(cli('valid.toml', 'get', 'sim.shooter_udid').stdout, '00000000-0000-0000-0000-000000000000\n');
  assert.equal(cli('valid.toml', 'get', 'dev.wait_ports').stdout, '8080\n9099\n');
  assert.equal(cli('valid.toml', 'get', 'targets.1.name').stdout, 'site\n');
  assert.equal(cli('valid.toml', 'get', 'dev.agents_may_start').stdout, 'false\n');
  assert.deepEqual(JSON.parse(cli('valid.toml', 'get', 'dev.read_api').stdout), {
    cwd: '/tmp/example',
    cmd: 'npm run dev -w api',
    port: 3002,
  });
});

test('cli: get of an unset key exits 3 with a message', () => {
  const r = cli('valid.toml', 'get', 'sim.nope');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /sim\.nope is not set/);
});

test('cli: get refuses to answer from an invalid config', () => {
  const r = cli('wrong-type.toml', 'get', 'kit.ref');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('cli: usage errors exit 2', () => {
  assert.equal(cli('valid.toml', 'frobnicate').status, 2);
  assert.equal(cli('valid.toml', 'get').status, 2);
  assert.equal(cli('valid.toml', 'env').status, 2);
});

// ---- proof sections ------------------------------------------------------

test('cli: get --raw keeps {placeholders} as written, the plain get fills the config ones', () => {
  assert.equal(cli('valid.toml', 'get', 'proof.ios.app').stdout, 'app/Build/Example.app\n');
  assert.equal(cli('valid.toml', 'get', '--raw', 'proof.ios.app').stdout, '{dd}/Build/Example.app\n');
  assert.equal(cli('valid.toml', 'get', 'proof.ios.launch_env.OPEN').stdout, 'example-trip\n');
  assert.equal(JSON.parse(cli('valid.toml', 'get', '--raw', 'proof.ios.launch_env').stdout).OPEN, '{trip}');
  assert.equal(cli('valid.toml', 'get', '--raw', 'proof.nope').status, 3);
  assert.equal(cli('valid.toml', 'get', '--raw').status, 2);
});

test('proof: matrices, their options and the cells they name are in the schema', () => {
  const { resolved: c, errors } = load(validText);
  assert.deepEqual(errors, []);
  assert.deepEqual(c.proof.matrix.default.cells, ['light', 'dark', 'small']);
  assert.equal(c.proof.matrix['first-launch'].warm_launch, false);
  assert.equal(c.proof.matrix['first-launch'].seconds, 30);
  assert.deepEqual(c.proof.cell.small.device_types, ['iPhone-SE-3rd-generation', 'iPhone-16e']);
  assert.equal(c.proof.cell.dark.sim, 'shooter');
});

test('proof: a cell needs sim, system and app; an unknown cell key is a typo', () => {
  const r = load(validText.replace('sim    = "shooter"\nsystem = "dark"\n', 'system = "dark"\nsimm = "shooter"\n'));
  const msgs = r.errors.map((e) => e.message);
  assert.ok(msgs.includes("missing required key 'sim'"));
  assert.ok(msgs.some((m) => /unknown key 'simm' in \[proof\.cell\.dark\]/.test(m)));
});

test('proof: [proof.ios.verdict] takes the verdict tool thresholds', () => {
  const r = load(validText.replace('flash_warn = 4', 'flash_warn = 4.5\nhold_fail_ms = 80\nbounce_window_s = 1.2\nlaunch_search_s = 90'));
  assert.deepEqual(r.errors, []);
  const sh = toEnvSh(r.resolved, '/tmp/example/factory.toml');
  assert.match(sh, /^export FK_PROOF_IOS_VERDICT_FLASH_WARN='4.5'$/m);
  assert.match(sh, /^export FK_PROOF_IOS_VERDICT_HOLD_FAIL_MS='80'$/m);
  assert.match(sh, /^export FK_PROOF_IOS_VERDICT_LAUNCH_SEARCH_S='90'$/m);
  assert.match(sh, /^export FK_PROOF_IOS_BUDGETS='tools\/budgets.json'$/m);
});

test('disk and sim: clips, $TMPDIR sweeps and the simulator erase keys are in the schema', () => {
  const add = (text, table, lines) => text.replace(`[${table}]\n`, `[${table}]\n${lines}\n`);
  let text = add(validText, 'disk', 'clips = "keep"\ntmp_dirs = ["$TMPDIR", "$TMPDIR/sub"]\ntmp_dirs_globs = ["*.ktrace"]');
  text = add(text, 'sim', 'erase_above_gb = 0.5\nerase_at_end_night = ["Shooter *", "ABC"]');
  const r = load(text);
  assert.deepEqual(r.errors, []);
  const sh = toEnvSh(r.resolved, '/tmp/example/factory.toml');
  assert.match(sh, /^export FK_DISK_CLIPS='keep'$/m);
  assert.match(sh, /^export FK_DISK_TMP_DIRS='\$TMPDIR\n\$TMPDIR\/sub'$/m);
  assert.match(sh, /^export FK_SIM_ERASE_ABOVE_GB='0.5'$/m);
  assert.match(sh, /^export FK_SIM_ERASE_AT_END_NIGHT='Shooter \*\nABC'$/m);
  // wrong types are caught
  const bad = load(add(add(validText, 'disk', 'clips = true'), 'sim', 'erase_above_gb = "six"'));
  assert.equal(bad.errors.length, 2);
});
