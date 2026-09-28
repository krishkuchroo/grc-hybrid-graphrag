// Login, users and sessions (D49, D54): Better Auth, the global SessionGuard and GET /api/v1/me.
// Better Auth's routes are mounted on Fastify by the API program (src/identity/auth-routes.ts).
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { AuthService } from './auth.js';
import './auth-docs.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';

export class IdentityModule {}
Module({
  imports: [AuditModule],
  controllers: [MeController],
  providers: [
    {
      provide: AuthService,
      useFactory: (db: Db, audit: AuditService) => new AuthService(db, audit),
      inject: [DB, AuditService],
    },
    { provide: APP_GUARD, useFactory: (auth: AuthService) => new SessionGuard(auth), inject: [AuthService] },
  ],
  exports: [AuthService],
})(IdentityModule);
