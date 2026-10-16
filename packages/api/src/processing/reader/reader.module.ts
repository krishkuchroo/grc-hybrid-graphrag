// Processing part 1, the reader (S4-004): `processing.document-read` reads a stored document's text
// in the worker's file sandbox and cuts it into chunks (D71). Its job handlers register in the
// worker program only, and the module declares its own imports.
import { Module } from '@nestjs/common';

export class ReaderModule {}
Module({})(ReaderModule);
