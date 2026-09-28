// M0-012 criterion 4 (D56, D72): verifyChain passes on an intact chain and reports the exact seq
// when a row is tampered with. Tampering is done as the migration account with the trigger off.
// Plus the nightly check's work (`runVerifyChains`): an `audit.chain_broken` event and an error
// log line for a broken chain, nothing for an intact one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendMany,
  column,
  LogCapture,
  makeLogger,
  newOrg,
  setUpAudit,
  stored,
  tamper,
  tearDownAudit,
  type AuditEnv,
} from './helpers.js';

let env: AuditEnv | undefined;

function e(): AuditEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

beforeAll(async () => {
  env = await setUpAudit();
}, 180_000);

afterAll(async () => {
  await tearDownAudit(env);
});

async function chainOf(name: string, count = 10): Promise<string> {
  const org = await newOrg(e(), name);
  await appendMany(e(), org.id, count);
  return org.id;
}

describe('criterion 4: verifyChain on an intact chain', () => {
  it('passes', async () => {
    const orgId = await chainOf('Intact');
    await expect(e().audit.verifyChain(orgId)).resolves.toEqual({ ok: true });
  });

  it('passes on an org with no entries yet', async () => {
    const org = await newOrg(e(), 'Empty');
    await expect(e().audit.verifyChain(org.id)).resolves.toEqual({ ok: true });
  });
});

describe('criterion 4: verifyChain reports the exact seq of a tampered row', () => {
  for (const seq of [1, 6, 10]) {
    it(`a changed action at seq ${seq} is reported as brokenAtSeq ${seq}`, async () => {
      const orgId = await chainOf(`Action ${seq}`);
      await tamper(e(), orgId, seq, `"${column(e(), 'action')}" = 'risk.deleted'`);
      await expect(e().audit.verifyChain(orgId)).resolves.toEqual({ ok: false, brokenAtSeq: seq });
    });
  }

  it('a changed "after" value is reported at its seq', async () => {
    const orgId = await chainOf('After');
    await tamper(e(), orgId, 4, `"${column(e(), 'after')}" = '{"status":"retired","score":0}'`);
    await expect(e().audit.verifyChain(orgId)).resolves.toEqual({ ok: false, brokenAtSeq: 4 });
  });

  it('a changed actor is reported at its seq', async () => {
    const orgId = await chainOf('Actor');
    await tamper(e(), orgId, 7, `"${column(e(), 'actorId')}" = 'someone-else'`);
    await expect(e().audit.verifyChain(orgId)).resolves.toEqual({ ok: false, brokenAtSeq: 7 });
  });

  it('a changed stored hash is reported at its seq', async () => {
    const orgId = await chainOf('Hash');
    await tamper(e(), orgId, 5, `"${column(e(), 'hash')}" = '${'f'.repeat(64)}'`);
    await expect(e().audit.verifyChain(orgId)).resolves.toEqual({ ok: false, brokenAtSeq: 5 });
  });

  it('a changed prevHash is reported at its seq', async () => {
    const orgId = await chainOf('Prev');
    await tamper(e(), orgId, 3, `"${column(e(), 'prevHash')}" = '${'0'.repeat(64)}'`);
    await expect(e().audit.verifyChain(orgId)).resolves.toEqual({ ok: false, brokenAtSeq: 3 });
  });

  it('tampering in one org leaves the other org’s chain passing', async () => {
    const a = await chainOf('Tamper A');
    const b = await chainOf('Tamper B');
    await tamper(e(), a, 2, `"${column(e(), 'action')}" = 'x'`);
    await expect(e().audit.verifyChain(a)).resolves.toEqual({ ok: false, brokenAtSeq: 2 });
    await expect(e().audit.verifyChain(b)).resolves.toEqual({ ok: true });
  });
});

describe('the nightly check (runVerifyChains)', () => {
  it('for a broken chain: appends audit.chain_broken to that org’s chain and logs an error naming the org and seq', async () => {
    const broken = await chainOf('Nightly Broken', 8);
    const intact = await chainOf('Nightly Intact', 8);
    await tamper(e(), broken, 3, `"${column(e(), 'action')}" = 'x'`);

    const capture = new LogCapture();
    const log = await makeLogger(capture);
    await e().mods.runVerifyChains({ audit: e().audit, log, orgIds: [broken, intact] });

    const brokenRows = await stored(e(), broken);
    const alerts = brokenRows.filter((r) => r.action === 'audit.chain_broken');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.actorType).toBe('system');
    expect(JSON.stringify({ meta: alerts[0]!.meta, after: alerts[0]!.after })).toMatch(/"brokenAtSeq":3\b/);

    const intactRows = await stored(e(), intact);
    expect(intactRows.filter((r) => r.action === 'audit.chain_broken')).toEqual([]);
    expect(intactRows).toHaveLength(8);

    const errors = capture.lines
      .map((l) => JSON.parse(l) as { level: number } & Record<string, unknown>)
      .filter((l) => l.level >= 50);
    expect(errors.length, 'one error log line for the broken chain').toBeGreaterThanOrEqual(1);
    const text = errors.map((l) => JSON.stringify(l)).join('\n');
    expect(text).toContain(broken);
    expect(text).toMatch(/\b3\b/);
    expect(text).not.toContain(intact);
  });

  it('for intact chains: writes no event and no error line', async () => {
    const a = await chainOf('Quiet A', 4);
    const b = await chainOf('Quiet B', 4);
    const capture = new LogCapture();
    const log = await makeLogger(capture);
    await e().mods.runVerifyChains({ audit: e().audit, log, orgIds: [a, b] });
    expect(await stored(e(), a)).toHaveLength(4);
    expect(await stored(e(), b)).toHaveLength(4);
    const errors = capture.lines.map((l) => JSON.parse(l) as { level: number }).filter((l) => l.level >= 50);
    expect(errors).toEqual([]);
  });

  it('the queue is named audit.verify-chains', () => {
    expect(e().mods.VERIFY_CHAINS_QUEUE).toBe('audit.verify-chains');
  });
});
