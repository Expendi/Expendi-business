import { z } from "zod";

export const categorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Spending in this category has no eTIMS invoice by nature (spec §6.6). */
  etimsNotRequired: z.boolean(),
});

export type Category = z.infer<typeof categorySchema>;

/**
 * `GET …/categories`: the company's categories that aren't archived, sorted
 * by name. Admins and accountants can ask for `archived=true` instead.
 */
export const categoriesResponseSchema = z.array(categorySchema);

export type CategoriesResponse = z.infer<typeof categoriesResponseSchema>;

export const listCategoriesQuerySchema = z.object({
  archived: z
    .enum(["true", "false"], { error: "archived is true or false." })
    .transform((value) => value === "true")
    .optional(),
});

export type ListCategoriesQuery = z.input<typeof listCategoriesQuerySchema>;

export const CATEGORY_NAME_MAX_LENGTH = 60;

const nameCategory = "Name the category, e.g. Transport.";

const categoryName = z
  .string({ error: nameCategory })
  .trim()
  .min(1, nameCategory)
  .max(
    CATEGORY_NAME_MAX_LENGTH,
    `Keep the name to ${CATEGORY_NAME_MAX_LENGTH} characters or fewer.`,
  );

/** `POST …/categories` (admins, spec §6.14). */
export const createCategoryRequestSchema = z.object({
  name: categoryName,
  etimsNotRequired: z.boolean().default(false),
});

export type CreateCategoryRequest = z.input<typeof createCategoryRequestSchema>;

/**
 * `PATCH …/categories/:categoryId` (admins): renames a category or marks it
 * eTIMS-exempt; a field left out is unchanged. An archived category is
 * restored first.
 */
export const updateCategoryRequestSchema = z
  .object({
    name: categoryName.optional(),
    etimsNotRequired: z.boolean().optional(),
  })
  .refine(
    (changes) =>
      changes.name !== undefined || changes.etimsNotRequired !== undefined,
    { message: "Say what to change: the name or eTIMS." },
  );

export type UpdateCategoryRequest = z.input<typeof updateCategoryRequestSchema>;

/**
 * A category as an admin manages it. Archived categories stay on the
 * spending that already has them but can't be picked for new spending.
 */
export const managedCategorySchema = categorySchema.extend({
  archived: z.boolean(),
});

export type ManagedCategory = z.infer<typeof managedCategorySchema>;
