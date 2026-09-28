// Lets Node run the TypeScript sources directly (D165): our imports name `./x.js`, as TypeScript
// wants, while the file on disk is `./x.ts`. When a relative `.js` import is not found, this tries
// the `.ts` file next to it. Loaded with `--import` by the start:api and start:worker scripts.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
