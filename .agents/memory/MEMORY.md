# Memory Index

- [Uploads storage](uploads-object-storage.md) — document files live in Replit Object Storage (uploads/<filename>); autoscale prod disk is ephemeral, never store user files on disk.
- [Orval codegen quirks](orval-codegen.md) — orval rewrites lib/api-zod/src/index.ts unless indexFiles:false; zod+types barrels collide (TS2308), export only generated/api.
