// Processing part 6, mapping suggestions (S4-009): `processing.mapping-suggest` has Gemma suggest
// control-to-requirement and SOC 2 cross-framework links, all for the Analyst (D16(b), D20). Its job
// handlers register in the worker program only, and the module declares its own imports.
import { Module } from '@nestjs/common';

export class SuggestModule {}
Module({})(SuggestModule);
