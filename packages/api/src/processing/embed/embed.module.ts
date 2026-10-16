// Processing part 2, embedding (S4-005): `processing.document-embed` gives each chunk its bge-m3
// vector, and records get their name embeddings (D70, D203). Its job handlers register in the
// worker program only, and the module declares its own imports.
import { Module } from '@nestjs/common';

export class EmbedModule {}
Module({})(EmbedModule);
