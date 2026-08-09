---
name: Uploads storage
description: Where document files are stored and why disk uploads broke in production
---
Document uploads are stored in Replit Object Storage under `uploads/<generated-filename>` (private dir from `PRIVATE_OBJECT_DIR`), via helpers in `artifacts/api-server/src/lib/fileStore.ts`. The content route falls back to the legacy local `uploads/` dir for pre-migration dev files.

**Why:** The published app runs on autoscale deployment with an ephemeral disk — files written to the server disk vanish when instances recycle (confirmed Aug 2026: docs uploaded before an instance recycle returned 404 on prod). Never store user files on local disk.

**How to apply:** Any new file-persisting feature must write through object storage, not `fs`. Files lost before the migration are unrecoverable and must be re-uploaded by the user. Fix only reaches production after republish.
