---
name: Orval codegen quirks
description: api-zod barrel export collisions and how codegen overwrites manual edits
---
- Orval regenerates `lib/api-zod/src/index.ts` on every codegen run unless `indexFiles: false` is set in the zod output block of `lib/api-spec/orval.config.ts` (it is set now). The manual barrel exports only `./generated/api`.
- **Why:** exporting both `generated/api` (zod consts) and `generated/types` (interfaces) from one barrel produces TS2308 duplicate-export errors — even with `export type *`. No consumer imports the interfaces; routes use the zod schemas.
- **How to apply:** after editing `openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen`; if TS2308 reappears in api-zod, check that `indexFiles: false` and the one-line barrel are intact.
