// Guard rail 1 (D84, D98, D106): nothing touches orion-neo4j, sentry-neo4j,
// or other projects' containers, volumes, networks or Compose projects. Ours
// are named grc-… (volumes and networks may also be grc_…).
import { isAbsolute, resolve } from 'node:path';
import { PROJECT_DIR, expandHome, isInside, realish } from './lib/paths.mjs';
import { block, isMain, runPreToolGuard } from './lib/run.mjs';
import { dynamicCommand, envSettings, findInvocations, leadingAssignments, parseCommand, workingDirs } from './lib/shell.mjs';

const PROTECTED_NAMES = /(?:orion|sentry)-neo4j/i;
const OURS = /^grc[-_]/;
const OUR_PROJECT = /^grc(?:[-_]|$)/;

const DOCKER_GLOBAL_WITH_VALUE = new Set(['-c', '--context', '-H', '--host', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);
const MANAGEMENT = new Set(['container', 'volume', 'network', 'image', 'system', 'builder', 'buildx', 'compose', 'stack', 'service', 'swarm', 'node', 'plugin', 'context', 'secret', 'config', 'trust', 'manifest', 'checkpoint']);
const STOP_OR_REMOVE = new Set(['stop', 'kill', 'restart', 'pause', 'rm', 'remove']);
const TARGET_FLAGS_WITH_VALUE = new Set(['-t', '--time', '--timeout', '-s', '--signal']);
const COMPOSE_FLAGS_WITH_VALUE = new Set(['--env-file', '--profile', '--progress', '--parallel', '--ansi']);

function skipDockerGlobals(args) {
  let k = 0;
  while (k < args.length && args[k].value.startsWith('-')) k += DOCKER_GLOBAL_WITH_VALUE.has(args[k].value) ? 2 : 1;
  return args.slice(k);
}

function checkTargets(kind, words) {
  const names = [];
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k];
    if (w.value.startsWith('-')) {
      if (TARGET_FLAGS_WITH_VALUE.has(w.value)) k += 1;
      continue;
    }
    names.push(w);
  }
  if (!names.length) return `can't confirm which ${kind} this stops or removes, so it's blocked (D98, D106)`;
  const bad = names.find((w) => w.dynamic || !OURS.test(w.value));
  if (bad) return `${kind} "${bad.value}" isn't ours. Only grc-… ${kind}s can be stopped or removed (D98, D106)`;
  return null;
}

function resolveFrom(base, value) {
  const v = expandHome(value);
  return isAbsolute(v) ? resolve(v) : resolve(base, v);
}

function checkCompose(args, dir, env) {
  const files = [];
  let project;
  let projectDir = null;
  if (env.COMPOSE_PROJECT_NAME !== undefined) project = env.COMPOSE_PROJECT_NAME;
  if (env.COMPOSE_FILE !== undefined) {
    if (env.COMPOSE_FILE === null) files.push({ value: '', dynamic: true });
    else for (const f of env.COMPOSE_FILE.split(':')) files.push({ value: f, dynamic: false });
  }
  for (let k = 0; k < args.length; k += 1) {
    const w = args[k];
    const v = w.value;
    const next = () => args[++k] ?? { value: '', dynamic: true };
    if (v === '-f' || v === '--file') files.push(next());
    else if (v.startsWith('--file=')) files.push({ value: v.slice(7), dynamic: w.dynamic });
    else if (v === '-p' || v === '--project-name') {
      const p = next();
      project = p.dynamic ? null : p.value;
    } else if (v.startsWith('--project-name=')) project = w.dynamic ? null : v.slice(15);
    else if (v === '--project-directory') projectDir = next();
    else if (v.startsWith('--project-directory=')) projectDir = { value: v.slice(20), dynamic: w.dynamic };
    else if (COMPOSE_FLAGS_WITH_VALUE.has(v)) k += 1;
    else if (!v.startsWith('-')) break;
  }
  if (project === null) return "can't confirm the Compose project is ours (grc), so it's blocked (D106)";
  if (project !== undefined && !OUR_PROJECT.test(project)) return `Compose project "${project}" isn't ours (grc) (D106)`;
  const root = realish(PROJECT_DIR);
  const base = dir ?? root;
  const inside = (w) => !w.dynamic && w.value && w.value !== '-' && isInside(realish(resolveFrom(base, w.value)), root);
  for (const f of files) {
    if (!inside(f)) return `Compose file "${f.value}" isn't in this project (D106)`;
  }
  if (projectDir && !inside(projectDir)) return `Compose project folder "${projectDir.value}" isn't in this project (D106)`;
  if (!files.length && !projectDir) {
    if (dir === null) return "can't confirm which folder this Compose command runs in, so it's blocked (D106)";
    if (!isInside(realish(dir), root)) return `this Compose command would run against another project's folder (${dir}) (D106)`;
  }
  return null;
}

export function decideDocker(command, cwd, isAgent = false) {
  const text = String(command ?? '');
  const segments = parseCommand(text);
  // Also as the shell reads it, so quotes can't split the name (ori''on-neo4j).
  if (PROTECTED_NAMES.test(text) || segments.some((s) => s.words.some((w) => PROTECTED_NAMES.test(w.value)))) {
    return block('this command names orion-neo4j or sentry-neo4j, which belong to other projects (D98)', text);
  }
  if (/docker\.sock/.test(text)) {
    return block('direct access to the Docker socket is blocked; use the docker command (guard rail 1)', text);
  }
  if (isAgent) {
    // Fail safe (D119): what the guard rails can't read is blocked.
    const hidden = dynamicCommand(segments);
    if (hidden !== null) {
      return block(`the program this runs is built at run time (${hidden}), so guard rails 1 and 3 can't check it (D119). Write the command out.`, text);
    }
    const compose = envSettings(segments).find((e) => e.name.startsWith('COMPOSE_'));
    if (compose) return block(`setting ${compose.name} can point Docker Compose at another project, so agents don't set it (D106, D119)`, text);
  }
  const dirs = workingDirs(segments, cwd);
  for (const inv of findInvocations(segments, ['docker', 'docker-compose'])) {
    const dir = dirs[inv.segIndex];
    const env = leadingAssignments(inv.segment);
    let composeArgs = null;
    if (inv.name === 'docker-compose') {
      composeArgs = inv.args;
    } else {
      const words = skipDockerGlobals(inv.args);
      if (words.some((w) => w.value === 'prune')) return block('Docker-wide cleanup (prune) is blocked (D98)', text);
      const first = words[0]?.value;
      if (first === 'compose') {
        composeArgs = words.slice(1);
      } else {
        const managed = MANAGEMENT.has(first);
        const group = managed ? first : 'container';
        const verb = managed ? words[1]?.value : first;
        const rest = words.slice(managed ? 2 : 1);
        if (group === 'container' && STOP_OR_REMOVE.has(verb)) {
          const reason = checkTargets('container', rest);
          if (reason) return block(reason, text);
        }
        if ((group === 'volume' || group === 'network') && (verb === 'rm' || verb === 'remove')) {
          const reason = checkTargets(group, rest);
          if (reason) return block(reason, text);
        }
      }
    }
    if (composeArgs) {
      const reason = checkCompose(composeArgs, dir, env);
      if (reason) return block(reason, text);
    }
  }
  return null;
}

if (isMain(import.meta.url)) {
  // Wired to Bash only; any call carrying a command is checked.
  runPreToolGuard('1', (input) =>
    typeof input.toolInput.command === 'string' ? decideDocker(input.toolInput.command, input.cwd, Boolean(input.agentId)) : null,
  );
}
