// The one entry point `exports` names. What the API returns, in the server's
// shape (dates as Date), the request bodies the client sends, the limits both
// sides check, and the string unions both packages use, each derived from an
// `as const` array. No zod: its schemas stay in the server, so none of it
// reaches the client bundle. See ADR-0006.
export * from './account.ts';
export * from './api.ts';
export * from './auth.ts';
export * from './book.ts';
export * from './chapter.ts';
export * from './comment.ts';
export * from './favorite.ts';
export * from './genre.ts';
export * from './illustration.ts';
export * from './library.ts';
export * from './like.ts';
export * from './notification.ts';
export * from './permission.ts';
export * from './readingList.ts';
export * from './report.ts';
export * from './role.ts';
export * from './series.ts';
export * from './user.ts';
export * from './wire.ts';
export * from './work.ts';
