// Processing part 3, extraction (S4-006): `processing.chunk-extract` asks Gemma for the records and
// links a chunk states (D38, D52). Its job handlers register in the worker program only, and the
// module declares its own imports.
import { Module } from '@nestjs/common';

export class ExtractModule {}
Module({})(ExtractModule);
