import assert from "node:assert/strict";
import test from "node:test";
import { mergePersistedWork, runMutationThenRefresh, runWorkDeletionStages } from "./consistency.ts";
import type { Work, WorkWithAssets } from "./types.ts";

function row(overrides: Partial<Work> = {}): Work {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    user_id: "00000000-0000-4000-8000-000000000001",
    title: "作品",
    body: "正文",
    source_music_track_id: null,
    published: false,
    created_at: "2026-09-13T00:00:00.000Z",
    updated_at: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

test("create success remains persisted when post-create hydration fails", async () => {
  const view: { current: Work | null } = { current: null };
  const created = row();
  const result = await runMutationThenRefresh(
    async () => created,
    async () => { throw new Error("profiles unavailable"); },
    (persisted) => { view.current = persisted; },
  );
  assert.equal(result.persisted.id, created.id);
  assert.equal(result.hydrated, null);
  assert.ok(result.refreshError);
  assert.equal(view.current?.id, created.id);
});

test("update success remains persisted when post-update hydration fails", async () => {
  const updated = row({ title: "已保存的新标题" });
  let visibleTitle = "旧标题";
  const result = await runMutationThenRefresh(
    async () => updated,
    async () => { throw new Error("assets unavailable"); },
    (persisted) => { visibleTitle = persisted.title; },
  );
  assert.equal(visibleTitle, "已保存的新标题");
  assert.equal(result.persisted.title, "已保存的新标题");
  assert.ok(result.refreshError);
});

test("a real mutation failure still rejects before persisted state is reported", async () => {
  let persisted = false;
  await assert.rejects(() => runMutationThenRefresh(
    async () => { throw new Error("insert rejected"); },
    async (value: Work) => value,
    () => { persisted = true; },
  ));
  assert.equal(persisted, false);
});

test("an unpublished work stays visibly draft when attachment deletion later fails", async () => {
  const published: WorkWithAssets = { ...row({ published: true }), assets: [], author: null };
  let visible = published;
  const result = await runMutationThenRefresh(
    async () => row({ published: false }),
    async () => { throw new Error("refresh unavailable"); },
    (persisted) => { visible = mergePersistedWork(visible, persisted); },
  );
  await assert.rejects(async () => { throw new Error("storage delete failed"); });
  assert.equal(result.persisted.published, false);
  assert.equal(visible.published, false);
});

test("work deletion stages run in the required destructive order", async () => {
  const events: string[] = [];
  await runWorkDeletionStages({
    unpublish: async () => { events.push("unpublish"); },
    deleteStorage: async () => { events.push("storage"); },
    deleteAssetRows: async () => { events.push("asset rows"); },
    deleteWorkRow: async () => { events.push("work row"); },
  });
  assert.deepEqual(events, ["unpublish", "storage", "asset rows", "work row"]);
});

test("a failed deletion stage prevents every later destructive stage", async () => {
  const stageNames = ["unpublish", "storage", "asset rows"] as const;

  for (const failedStage of stageNames) {
    const events: string[] = [];
    await assert.rejects(() => runWorkDeletionStages({
      unpublish: async () => {
        events.push("unpublish");
        if (failedStage === "unpublish") throw new Error("unpublish rejected");
      },
      deleteStorage: async () => {
        events.push("storage");
        if (failedStage === "storage") throw new Error("storage rejected");
      },
      deleteAssetRows: async () => {
        events.push("asset rows");
        if (failedStage === "asset rows") throw new Error("asset row deletion rejected");
      },
      deleteWorkRow: async () => { events.push("work row"); },
    }));

    assert.equal(events.at(-1), failedStage);
    assert.equal(events.includes("work row"), false);
  }
});
