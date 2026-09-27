// The storage module (D28): provides the FileStore, built from the environment.
// S3_ENDPOINT is the internal address in the containers and 127.0.0.1:8333 on the Mac (D132, D138).
import { Module } from '@nestjs/common';
import { FILE_STORE, type FileStore } from './file-store.js';
import { SeaweedFileStore } from './seaweed-file-store.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function fileStoreFromEnv(): FileStore {
  return new SeaweedFileStore({
    endpoint: required('S3_ENDPOINT'),
    accessKey: required('S3_ACCESS_KEY'),
    secretKey: required('S3_SECRET_KEY'),
  });
}

@Module({
  providers: [{ provide: FILE_STORE, useFactory: fileStoreFromEnv }],
  exports: [FILE_STORE],
})
export class StorageModule {}
