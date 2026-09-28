// Test fixture (M0-014 follow-up, D164): loaded with `node --import` in front of
// `pnpm org:create` / `pnpm seed:demo`. It swaps `src/identity/provision-org.ts` for
// failing-provision-org.mjs, whose provisionOrg throws the kind of error a failed Postgres write
// throws, with the org's values inside it. No database is touched.
import { registerHooks } from 'node:module';

const FAKE = new globalThis.URL('./failing-provision-org.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.endsWith('/api/src/identity/provision-org.ts')) return { ...resolved, url: FAKE };
    return resolved;
  },
});
