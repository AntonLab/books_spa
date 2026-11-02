// Type-level assertions that every request body the client sends, as `shared`
// declares it, still parses under the schema that guards its route. Nothing
// runs this file: `npm run typecheck` compiles it, and a drift fails there as
// `Type 'false' does not satisfy the constraint 'true'`.
//
// The check runs one way only, payload into `z.input`: the client may be
// stricter than the server (it always sends `tags`, which the server would
// default), but never send a key the schema does not know or omit one the
// schema requires.
import type {
  AddReadingListItemPayload,
  CreateBookPayload,
  CreateChapterPayload,
  CreateCommentPayload,
  CreateFavoritePayload,
  CreateLikePayload,
  GenrePayload,
  LoginPayload,
  ReadingListPayload,
  RegisterPayload,
  ReorderReadingListItemsPayload,
  ReportPayload,
  ResetConfirmPayload,
  ResetRequestPayload,
  SeriesPayload,
  UpdateBookPayload,
  UpdateChapterPayload,
  UpdateUserPayload,
} from 'shared';
import type { z } from 'zod';
import type {
  loginSchema,
  registerSchema,
  resetConfirmSchema,
  resetRequestSchema,
} from './auth.ts';
import type { createBookSchema, updateBookSchema } from './book.ts';
import type { createChapterSchema, updateChapterSchema } from './chapter.ts';
import type { createCommentSchema } from './comment.ts';
import type { createFavoriteSchema } from './favorite.ts';
import type { genreBodySchema } from './genre.ts';
import type { createLikeSchema } from './like.ts';
import type {
  addReadingListItemSchema,
  createReadingListSchema,
  reorderReadingListItemsSchema,
  updateReadingListSchema,
} from './readingList.ts';
import type { createReportSchema } from './report.ts';
import type { createSeriesSchema, updateSeriesSchema } from './series.ts';
import type { updateUserSchema } from './user.ts';

type Expect<T extends true> = T;

// Distributes over a union payload, so each of its members must fit.
type Fits<Payload, Schema extends z.ZodType> =
  Payload extends z.input<Schema>
    ? keyof Payload extends keyof z.input<Schema>
      ? true
      : false
    : false;

// Exported only so that noUnusedLocals leaves the tuple alone.
export type PayloadAssertions = [
  Expect<Fits<CreateBookPayload, typeof createBookSchema>>,
  Expect<Fits<UpdateBookPayload, typeof updateBookSchema>>,
  Expect<Fits<SeriesPayload, typeof createSeriesSchema>>,
  Expect<Fits<Partial<SeriesPayload>, typeof updateSeriesSchema>>,
  Expect<Fits<CreateChapterPayload, typeof createChapterSchema>>,
  Expect<Fits<UpdateChapterPayload, typeof updateChapterSchema>>,
  Expect<Fits<CreateCommentPayload, typeof createCommentSchema>>,
  Expect<Fits<GenrePayload, typeof genreBodySchema>>,
  Expect<Fits<CreateLikePayload, typeof createLikeSchema>>,
  Expect<Fits<CreateFavoritePayload, typeof createFavoriteSchema>>,
  Expect<Fits<ReadingListPayload, typeof createReadingListSchema>>,
  Expect<Fits<Partial<ReadingListPayload>, typeof updateReadingListSchema>>,
  Expect<Fits<AddReadingListItemPayload, typeof addReadingListItemSchema>>,
  Expect<
    Fits<ReorderReadingListItemsPayload, typeof reorderReadingListItemsSchema>
  >,
  Expect<Fits<ReportPayload, typeof createReportSchema>>,
  Expect<Fits<UpdateUserPayload, typeof updateUserSchema>>,
  Expect<Fits<RegisterPayload, typeof registerSchema>>,
  Expect<Fits<LoginPayload, typeof loginSchema>>,
  Expect<Fits<ResetRequestPayload, typeof resetRequestSchema>>,
  Expect<Fits<ResetConfirmPayload, typeof resetConfirmSchema>>,
  // `status` stays out of UpdateUserPayload (see shared/src/user.ts).
  Expect<'status' extends keyof UpdateUserPayload ? false : true>,
];
