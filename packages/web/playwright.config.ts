import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { defineConfig } from '@playwright/test';

// The end-to-end run goes through the front door only (D60): https://grc.localhost, served by the
// running stack. No certificate exceptions: Caddy's local root must be trusted on the Mac (D65).
// The browser reads the Mac's trust store itself; Playwright's request context (page.request) runs
// in Node, which only has its bundled roots, so the Mac's trusted roots are added to them here.
// One browser, one worker (D82).
setDefaultCACertificates([...getCACertificates('bundled'), ...getCACertificates('system')]);
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'https://grc.localhost',
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
