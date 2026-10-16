// The Analyst review queue (S5; D24, D38, D50, D52.5, D207): the findings processing left, decided
// by the Analyst in their own view. One Nest module per part, each in its own folder, so a part's
// task never edits this file (S5-001):
//   queue/   S5-002  reading the queue: the list, a finding's detail and the counts
//   decide/  S5-003  approving and rejecting a finding
//   remove/  S5-004  removing a live fact, and every AI fact from one upload
// Every route runs in the API program; S5 adds no background job. The shared model (bodies, list
// query, answers, outcomes, names and plain words) is in @grc/shared (packages/shared/src/review/).
import { Module } from '@nestjs/common';
import { ReviewDecideModule } from './decide/decide.module.js';
import { ReviewQueueModule } from './queue/queue.module.js';
import { ReviewRemoveModule } from './remove/remove.module.js';

export class ReviewModule {}
Module({
  imports: [ReviewQueueModule, ReviewDecideModule, ReviewRemoveModule],
})(ReviewModule);
