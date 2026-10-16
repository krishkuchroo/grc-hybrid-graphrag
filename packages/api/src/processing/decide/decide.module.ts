// Processing part 5, the rule checks (S4-008): `processing.chunk-resolve` checks each extracted link
// (D39); confident ones go live in Neo4j, the rest wait in the review queue. Its job handlers
// register in the worker program only, and the module declares its own imports.
import { Module } from '@nestjs/common';

export class DecideModule {}
Module({})(DecideModule);
