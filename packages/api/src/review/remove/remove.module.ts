// Review part 3, removing what turned out false (S5-004): POST /api/v1/review/findings/:id/remove,
// GET /api/v1/review/documents/:id (a document's impact, Review-queue `view`) and
// POST /api/v1/review/documents/:id/remove (one bad upload in a single action, D52.5), the removals
// for the Review-queue `work` cell (the Analyst). Runs in the API program; the module declares its
// own imports.
import { Module } from '@nestjs/common';

export class ReviewRemoveModule {}
Module({})(ReviewRemoveModule);
