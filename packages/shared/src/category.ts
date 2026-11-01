import { z } from "zod";

export const categorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Spending in this category has no eTIMS invoice by nature (spec §6.6). */
  etimsNotRequired: z.boolean(),
});

export type Category = z.infer<typeof categorySchema>;

/** A company's categories that aren't archived, sorted by name. */
export const categoriesResponseSchema = z.array(categorySchema);

export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>;
