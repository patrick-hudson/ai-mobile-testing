import type {
  GalleryFlagHistory,
  GalleryFlagTransition,
  GalleryFlagEvent,
  GalleryFlagProjection,
} from '../shared/gallery-contract.mjs';

export interface GalleryFlagSnapshot {
  schemaVersion: 1;
  throughEvent: number;
  flagRevision: string;
  flags: GalleryFlagProjection[];
  events: GalleryFlagEvent[];
}

export interface GalleryFlagMutationResult {
  schemaVersion: 1;
  accepted: true;
  idempotent: boolean;
  event: GalleryFlagEvent;
  throughEvent: number;
  flagRevision: string;
  orderRevision: string | null;
  exportRevision: string | null;
  historyBytes: number;
}

export function readGalleryFlagHistory(runDirectory: string): Promise<GalleryFlagHistory>;
export function readGalleryFlagSnapshot(runDirectory: string): Promise<GalleryFlagSnapshot>;
export function mutateGalleryFlag(
  runDirectory: string,
  transition: GalleryFlagTransition,
): Promise<GalleryFlagMutationResult>;
export function galleryFlagSidecarExists(runDirectory: string): Promise<boolean>;
