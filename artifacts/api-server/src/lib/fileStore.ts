import fs from "fs";
import path from "path";
import type { File } from "@google-cloud/storage";
import { objectStorageClient, ObjectStorageService } from "./objectStorage";

const service = new ObjectStorageService();

function storageAvailable(): boolean {
  return !!process.env.PRIVATE_OBJECT_DIR;
}

function objectFileFor(filename: string): File {
  let dir = service.getPrivateObjectDir();
  if (!dir.endsWith("/")) dir = `${dir}/`;
  const fullPath = `${dir}uploads/${filename}`;
  // fullPath is like /<bucket>/<objectName>
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  return objectStorageClient.bucket(bucketName).file(objectName);
}

/** Persist an uploaded file buffer to object storage under uploads/<filename>. */
export async function saveFileToStorage(filename: string, buffer: Buffer, contentType: string): Promise<void> {
  const file = objectFileFor(filename);
  await file.save(buffer, { contentType, resumable: false });
}

/**
 * Resolve a stored document file for streaming.
 * Prefers object storage; falls back to the legacy local uploads dir.
 */
export async function getStoredFile(
  filename: string,
  uploadsDir: string,
): Promise<
  | { kind: "gcs"; file: File; size?: number }
  | { kind: "disk"; path: string; size: number }
  | null
> {
  if (storageAvailable()) {
    try {
      const file = objectFileFor(filename);
      const [exists] = await file.exists();
      if (exists) {
        const [metadata] = await file.getMetadata();
        return { kind: "gcs", file, size: metadata.size ? Number(metadata.size) : undefined };
      }
    } catch {
      // fall through to disk
    }
  }
  const diskPath = path.join(uploadsDir, filename);
  if (fs.existsSync(diskPath)) {
    return { kind: "disk", path: diskPath, size: fs.statSync(diskPath).size };
  }
  return null;
}

/** Delete a stored file from object storage and/or local disk. Best effort. */
export async function deleteStoredFile(filename: string, uploadsDir: string): Promise<void> {
  if (storageAvailable()) {
    try {
      await objectFileFor(filename).delete({ ignoreNotFound: true });
    } catch {
      // ignore
    }
  }
  const diskPath = path.join(uploadsDir, filename);
  if (fs.existsSync(diskPath)) {
    try { fs.unlinkSync(diskPath); } catch { /* ignore */ }
  }
}
