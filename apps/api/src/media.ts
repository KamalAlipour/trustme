import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Busboy from 'busboy';
import type { Request } from 'express';
import { PrismaClient, MediaKind } from '@trustme/db';
import { DomainError } from '@trustme/core';

const MB = 1024 * 1024;
const limits: Record<MediaKind, number> = {
  AUDIO: 10 * MB,
  IMAGE: 10 * MB,
  DOCUMENT: 10 * MB,
  VIDEO: 50 * MB,
};

type UploadResult = {
  kind: MediaKind;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
};

function requestedKind(value: string): MediaKind {
  const normalized = value.trim().toUpperCase();
  if (!(normalized in limits)) throw new DomainError('unsupported media kind', 415);
  return normalized as MediaKind;
}

function sniff(bytes: Buffer, kind: MediaKind): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return kind === MediaKind.IMAGE ? 'image/jpeg' : null;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return kind === MediaKind.IMAGE ? 'image/png' : null;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return kind === MediaKind.DOCUMENT ? 'application/pdf' : null;
  if (bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    if (kind === MediaKind.VIDEO) return 'video/mp4';
    if (kind === MediaKind.AUDIO) return 'audio/mp4';
    return null;
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xf1])) || bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xf9]))) {
    return kind === MediaKind.AUDIO ? 'audio/aac' : null;
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    if (kind === MediaKind.VIDEO) return 'video/webm';
    if (kind === MediaKind.AUDIO) return 'audio/webm';
  }
  return null;
}

export async function uploadMedia(request: Request, storageDir: string): Promise<UploadResult> {
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  return new Promise<UploadResult>((resolve, reject) => {
    let kind: MediaKind | undefined;
    let fileSeen = false;
    let fileEnded = false;
    let filePath: string | undefined;
    let storageKey: string | undefined;
    let output: ReturnType<typeof createWriteStream> | undefined;
    const hash = createHash('sha256');
    let size = 0;
    let header = Buffer.alloc(0);
    let mimeType: string | null = null;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      output?.destroy();
      void (filePath === undefined ? Promise.resolve() : rm(filePath, { force: true })).finally(() => reject(error));
    };
    let parser: Busboy.Busboy;
    try {
      parser = Busboy({ headers: request.headers, limits: { files: 1, fields: 4, parts: 5, fileSize: limits.VIDEO } });
    } catch {
      fail(new DomainError('invalid multipart request', 400));
      return;
    }
    parser.on('field', (name, value) => {
      if (name === 'kind') {
        try {
          kind = requestedKind(value);
          if (size > limits[kind]) {
            fail(new DomainError('media file is too large', 413));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new DomainError('unsupported media kind', 415));
        }
      }
    });
    parser.on('file', (_field, stream) => {
      if (fileSeen) {
        stream.resume();
        fail(new DomainError('one file per request is allowed', 400));
        return;
      }
      fileSeen = true;
      const uuid = randomUUID();
      storageKey = `${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
      filePath = join(storageDir, storageKey);
      void mkdir(dirname(filePath), { recursive: true, mode: 0o700 }).then(() => {
        if (settled || filePath === undefined) return;
        output = createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
        output.on('error', (error) => fail(error));
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limits.VIDEO || (kind !== undefined && size > limits[kind])) {
            stream.destroy(new DomainError('media file is too large', 413));
            return;
          }
          if (header.length < 16) header = Buffer.concat([header, chunk]).subarray(0, 16);
          hash.update(chunk);
          if (output === undefined) {
            fail(new DomainError('media upload failed', 400));
            return;
          }
          if (!output.write(chunk)) {
            stream.pause();
            output.once('drain', () => stream.resume());
          }
        });
        stream.on('limit', () => fail(new DomainError('media file is too large', 413)));
        stream.on('error', (error) => fail(error instanceof DomainError ? error : new DomainError('media upload failed', 400)));
        stream.on('end', () => {
          fileEnded = true;
          output?.end();
          if (kind !== undefined) mimeType = sniff(header, kind);
        });
      }).catch(fail);
    });
    parser.on('filesLimit', () => fail(new DomainError('one file per request is allowed', 400)));
    parser.on('error', fail);
    parser.on('finish', async () => {
      if (settled) return;
      if (!fileSeen || !fileEnded || filePath === undefined || storageKey === undefined || kind === undefined || output === undefined) {
        fail(new DomainError('multipart file is required', 400));
        return;
      }
      mimeType = sniff(header, kind);
      if (mimeType === null) {
        fail(new DomainError('unsupported media type', 415));
        return;
      }
      await new Promise<void>((resolveOutput) => output!.once('close', resolveOutput));
      settled = true;
      resolve({ kind, mimeType, byteSize: size, sha256: hash.digest('hex'), storageKey });
    });
    request.pipe(parser);
  });
}

export async function mediaPath(storageDir: string, storageKey: string): Promise<string> {
  const path = join(storageDir, storageKey);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('media is not a file');
  return path;
}

export async function deleteMediaFile(storageDir: string, storageKey: string): Promise<void> {
  await rm(join(storageDir, storageKey), { force: true });
}

export async function cleanupUnattachedMedia(prisma: PrismaClient, storageDir: string): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const assets = await prisma.mediaAsset.findMany({
    where: {
      refundRequestId: null,
      aidRequestId: null,
      createdAt: { lt: cutoff },
      identityReviewDocuments: { none: { status: 'PENDING' } },
      identityReviewSelfies: { none: { status: 'PENDING' } },
    },
  });
  for (const asset of assets) {
    const deleted = await prisma.mediaAsset.deleteMany({
      where: {
        id: asset.id,
        refundRequestId: null,
        aidRequestId: null,
        identityReviewDocuments: { none: { status: 'PENDING' } },
        identityReviewSelfies: { none: { status: 'PENDING' } },
      },
    });
    if (deleted.count === 1) await deleteMediaFile(storageDir, asset.storageKey);
  }
  return assets.length;
}
