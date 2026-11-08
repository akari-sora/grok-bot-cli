import { z } from 'zod';

// Every route exposes its outcome in JSON; a partial export is exit 3, not a silent success.
export const migrationResultSchema = z.object({
  exitCode: z.number().int().min(0).max(3),
}).catchall(z.json());
export const migrationResult = (value: unknown) => migrationResultSchema.parse(value);
