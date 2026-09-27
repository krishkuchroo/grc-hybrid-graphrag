import { PROJECT } from './helpers.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideDocker } from '../guard-docker.mjs';

const blocked = (command, cwd = PROJECT) => decideDocker(command, cwd) !== null;

test("blocks any command naming the other projects' containers", () => {
  for (const cmd of ['docker stop orion-neo4j', 'docker logs sentry-neo4j', 'docker ps | grep ORION-NEO4J']) assert.ok(blocked(cmd), cmd);
});

test('blocks raw Docker socket access', () => {
  assert.ok(blocked('curl --unix-socket /var/run/docker.sock http://localhost/containers/json'));
});

test('blocks Docker-wide cleanup', () => {
  for (const cmd of ['docker system prune -af', 'docker image prune', 'docker volume prune -f', 'docker container prune', 'docker network prune']) {
    assert.ok(blocked(cmd), cmd);
  }
});

test('stops and removes only grc- containers', () => {
  for (const cmd of ['docker stop grc-api grc-worker', 'docker container rm -f grc-postgres', 'docker stop -t 5 grc-api']) assert.ok(!blocked(cmd), cmd);
  for (const cmd of [
    'docker stop other-db',
    'docker rm -f grc-api other',
    'docker kill $(docker ps -q)',
    'docker stop "$NAME"',
    'docker restart',
    'sudo docker stop other',
    "bash -c 'docker stop other'",
  ]) {
    assert.ok(blocked(cmd), cmd);
  }
});

test('removes only grc volumes and networks', () => {
  assert.ok(!blocked('docker volume rm grc_pgdata grc-seaweed'));
  assert.ok(blocked('docker volume rm other_data'));
  assert.ok(!blocked('docker network rm grc-internal'));
  assert.ok(blocked('docker network remove bridge2'));
});

test('allows everyday commands', () => {
  for (const cmd of ['docker ps', 'docker logs -f grc-api', 'docker compose ps', 'docker exec grc-postgres psql -c "select 1"', 'docker volume ls']) {
    assert.ok(!blocked(cmd), cmd);
  }
});

test('quotes and escapes inside the protected names are still caught', () => {
  for (const cmd of ["docker logs ori''on-neo4j", 'docker logs "sen"try-neo4j', 'docker logs orion\\-neo4j']) assert.ok(blocked(cmd), cmd);
});

test("an agent's program name built at run time is blocked (D119)", () => {
  const agent = (cmd) => decideDocker(cmd, PROJECT, true);
  for (const cmd of ["$(echo docker) rm -f grc-api", '`echo docker` stop other', '$D volume rm x', 'eval "$X"', 'sudo $(which docker) ps']) {
    assert.match(agent(cmd)?.reason ?? '', /built at run time/, cmd);
  }
  assert.equal(decideDocker('$(echo docker) ps', PROJECT, false), null); // the main session isn't held to this
  for (const cmd of ['pnpm test', 'X=$(pwd) && echo $X', 'docker ps']) assert.equal(agent(cmd), null, cmd);
});

test('agents set no COMPOSE_ variables (D119)', () => {
  const agent = (cmd) => decideDocker(cmd, PROJECT, true);
  for (const cmd of [
    'export COMPOSE_PROJECT_NAME=other; docker compose down',
    'COMPOSE_FILE=/tmp/x.yml docker compose up',
    'declare -x COMPOSE_PROJECT_NAME=other',
    'env COMPOSE_PROJECT_NAME=other docker compose down',
    'COMPOSE_PROJECT_NAME=other; export COMPOSE_PROJECT_NAME',
  ]) {
    assert.match(agent(cmd)?.reason ?? '', /COMPOSE_/, cmd);
  }
  assert.equal(agent('FOO=1 pnpm test'), null);
});

test('runs Compose only on this project', () => {
  mkdirSync(join(PROJECT, 'infra'), { recursive: true });
  for (const cmd of ['docker compose up -d', 'docker compose -p grc up -d', 'docker compose -f infra/compose.yml up -d', 'cd infra && docker compose down']) {
    assert.ok(!blocked(cmd), cmd);
  }
  for (const cmd of [
    'docker compose -p other down',
    'docker-compose --project-name=orion down',
    'COMPOSE_PROJECT_NAME=other docker compose down',
    'docker compose -f /tmp/other/compose.yml down',
    'docker compose --project-directory /tmp/other down',
    'cd /tmp && docker compose down',
    'cd "$DIR" && docker compose down',
    'docker compose -p "$P" down',
  ]) {
    assert.ok(blocked(cmd), cmd);
  }
  assert.ok(blocked('docker compose down', '/tmp'));
});
