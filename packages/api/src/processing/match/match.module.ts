// Processing part 4, duplicate matching (S4-007): ties names to existing records (exact, close
// spelling, close meaning; D43), and `processing.record-dedupe` merges or flags records that
// duplicate each other. Its job handlers register in the worker program only, and the module
// declares its own imports.
import { Module } from '@nestjs/common';

export class MatchModule {}
Module({})(MatchModule);
