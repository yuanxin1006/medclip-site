import type { Work, WorkWithAssets } from "./types";

export type MutationRefreshResult<TPersisted, THydrated> = {
  persisted: TPersisted;
  hydrated: THydrated | null;
  refreshError: unknown | null;
};

export type WorkDeletionStages = {
  unpublish: (() => Promise<void>) | undefined;
  deleteStorage: () => Promise<void>;
  deleteAssetRows: () => Promise<void>;
  deleteWorkRow: () => Promise<void>;
};

export async function runWorkDeletionStages(stages: WorkDeletionStages): Promise<void> {
  if (stages.unpublish) await stages.unpublish();
  await stages.deleteStorage();
  await stages.deleteAssetRows();
  await stages.deleteWorkRow();
}

export function mergePersistedWork(previous: WorkWithAssets | null, persisted: Work): WorkWithAssets {
  return {
    ...persisted,
    assets: previous?.assets ?? [],
    author: previous?.author ?? null,
  };
}

export async function refreshPersistedMutation<TPersisted, THydrated>(
  persisted: TPersisted,
  refresh: (value: TPersisted) => Promise<THydrated>,
): Promise<MutationRefreshResult<TPersisted, THydrated>> {
  try {
    return { persisted, hydrated: await refresh(persisted), refreshError: null };
  } catch (refreshError) {
    return { persisted, hydrated: null, refreshError };
  }
}

export async function runMutationThenRefresh<TPersisted, THydrated>(
  mutate: () => Promise<TPersisted>,
  refresh: (value: TPersisted) => Promise<THydrated>,
  onPersisted: (value: TPersisted) => void,
): Promise<MutationRefreshResult<TPersisted, THydrated>> {
  const persisted = await mutate();
  onPersisted(persisted);
  return refreshPersistedMutation(persisted, refresh);
}
