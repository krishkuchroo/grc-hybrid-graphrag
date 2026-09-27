// FileStore on SeaweedFS's S3 API (D21), signed with the one backend-only service key (D57).
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { bucketForOrg, checkKey, type FileStore } from './file-store.js';

export interface SeaweedFileStoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

export class SeaweedFileStore implements FileStore {
  private readonly s3: S3Client;

  constructor(config: SeaweedFileStoreConfig) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  async ensureBucket(orgId: string): Promise<void> {
    const Bucket = bucketForOrg(orgId);
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket }));
    } catch (err) {
      if (err instanceof S3ServiceException && err.name === 'BucketAlreadyOwnedByYou') return;
      throw err;
    }
  }

  async put(orgId: string, key: string, body: Buffer, contentType: string): Promise<void> {
    const Bucket = bucketForOrg(orgId);
    await this.s3.send(new PutObjectCommand({ Bucket, Key: checkKey(key), Body: body, ContentType: contentType }));
  }

  async get(orgId: string, key: string): Promise<Buffer> {
    const Bucket = bucketForOrg(orgId);
    const res = await this.s3.send(new GetObjectCommand({ Bucket, Key: checkKey(key) }));
    return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : Buffer.alloc(0);
  }

  async exists(orgId: string, key: string): Promise<boolean> {
    const Bucket = bucketForOrg(orgId);
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket, Key: checkKey(key) }));
      return true;
    } catch (err) {
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return false;
      throw err;
    }
  }
}
