export interface PublicIllustration {
  id: number;
  position: number;
  caption: string | null;
  // Null for rows stored without a size.
  width: number | null;
  height: number | null;
  updatedAt: Date;
}
export const ILLUSTRATIONS_PER_CHAPTER_MAX = 20;
export const ILLUSTRATION_CAPTION_MAX_LENGTH = 200;
// Side of the square box an Illustration is fitted inside (px).
export const ILLUSTRATION_BOX = 1600;
