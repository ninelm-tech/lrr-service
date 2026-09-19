import { MediaContext, MediaType, UserRole } from '@prisma/client';

/**
 * A single evidence item as surfaced to admin dashboard callers — richer
 * than the flat `mediaLinks: string[]` array (which stays INITIAL-only and
 * unchanged for OPERATOR/CUSTOMER callers). `url` reuses the existing
 * `/api/v1/media/:id` signed-redirect endpoint.
 */
export interface RequestMediaDto {
  id: string;
  url: string;
  mediaType: MediaType;
  context: MediaContext;
  uploadedByRole: UserRole;
  createdAt: Date;
}
