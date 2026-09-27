// The API/worker feature modules (D46), shared by both programs (D36).
import { AccessModule } from './access/access.module.js';
import { AiModule } from './ai/ai.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ChatModule } from './chat/chat.module.js';
import { FrameworksModule } from './frameworks/frameworks.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { ProcessingModule } from './processing/processing.module.js';
import { RecordsModule } from './records/records.module.js';
import { ReviewModule } from './review/review.module.js';
import { SearchModule } from './search/search.module.js';

export const FEATURE_MODULES = [
  IdentityModule,
  AccessModule,
  AuditModule,
  RecordsModule,
  FrameworksModule,
  IntakeModule,
  ProcessingModule,
  ReviewModule,
  SearchModule,
  ChatModule,
  AiModule,
];
