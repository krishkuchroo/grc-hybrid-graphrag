// Login, users and sessions (D49, D54): Better Auth, the global SessionGuard, GET /api/v1/me, and
// machine API keys (M0-011).
// Better Auth's routes are mounted on Fastify by the API program (src/identity/auth-routes.ts).
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { AuthService } from './auth.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';

export class IdentityModule {}
Module({
  imports: [AuditModule],
  controllers: [MeController, ApiKeysController],
  providers: [
    {
      provide: AuthService,
      useFactory: (db: Db, audit: AuditService) => new AuthService(db, audit),
      inject: [DB, AuditService],
    },
    {
      provide: ApiKeysService,
      useFactory: (db: Db, audit: AuditService) => new ApiKeysService(db, audit),
      inject: [DB, AuditService],
    },
    { provide: ApiKeyGuard, useFactory: (keys: ApiKeysService) => new ApiKeyGuard(keys), inject: [ApiKeysService] },
    {
      provide: APP_GUARD,
      useFactory: (auth: AuthService, keys: ApiKeyGuard) => new SessionGuard(auth, keys),
      inject: [AuthService, ApiKeyGuard],
    },
  ],
  exports: [AuthService],
})(IdentityModule);
