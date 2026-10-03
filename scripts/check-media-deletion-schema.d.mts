export const MEDIA_DELETION_SCHEMA_QUERY: string;

export interface CheckMediaDeletionSchemaOptions {
  configText: string;
  configPath: string;
  cloudflareEnv?: string;
  run: (command: string, args: string[]) => string;
}

export function readWorkerD1Target(
  configText: string,
  configPath: string,
): {
  binding: "DB";
  databaseName: string;
  databaseId: string;
};

export function checkMediaDeletionSchema(
  options: CheckMediaDeletionSchemaOptions,
): {
  kind: "yurumeet.core-media-deletion-schema@v1";
  table: "media_blob_deletion_jobs";
  index: "media_blob_deletion_jobs_due_idx";
  scope: "migration-0030-only";
};
