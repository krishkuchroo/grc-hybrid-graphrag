// Lists are paged, with sorting (D47). Query-string values arrive as text, so numbers are coerced.
import { z } from 'zod';

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().min(1).max(100).optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
