import { createEffect, createSignal, For, on, Show } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { fetchPost, fetchReplies, type Post } from "@takosjp/yurucommu-api";
import { PageLayout, PageHeader } from "../components/PageLayout.tsx";
import { PostCard } from "../components/timeline/PostCard.tsx";
import { PostComposer } from "../components/timeline/PostComposer.tsx";
import { useApp } from "../lib/app-context.tsx";
import {
  decodeApIdParam,
  postPath,
  SpinnerIcon,
  titleFor,
} from "../lib/ui.tsx";

export default function PostDetailPage() {
  const params = useParams();
  const app = useApp();
  const navigate = useNavigate();
  const postApId = () => decodeApIdParam(params.postId);

  const [post, setPost] = createSignal<Post | null>(null);
  const [replies, setReplies] = createSignal<Post[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);
  const [replyOpen, setReplyOpen] = createSignal(false);
  const [replyCursor, setReplyCursor] = createSignal<string | null>(null);
  const [replyHasMore, setReplyHasMore] = createSignal(false);
  const [loadingMoreReplies, setLoadingMoreReplies] = createSignal(false);

  let gen = 0;
  const load = () => {
    const id = postApId();
    const myGen = ++gen;
    setLoading(true);
    setError(false);
    setPost(null);
    setReplies([]);
    setReplyCursor(null);
    setReplyHasMore(false);
    void (async () => {
      try {
        const [detail, replyPage] = await Promise.all([
          fetchPost(id),
          fetchReplies(id),
        ]);
        if (myGen !== gen) return;
        setPost(detail);
        setReplies(replyPage.replies);
        setReplyCursor(replyPage.nextCursor);
        setReplyHasMore(replyPage.hasMore);
      } catch {
        if (myGen === gen) setError(true);
      } finally {
        if (myGen === gen) setLoading(false);
      }
    })();
  };

  createEffect(on(postApId, load));

  const loadMoreReplies = async () => {
    const cursor = replyCursor();
    if (loadingMoreReplies() || !replyHasMore() || !cursor) return;
    setLoadingMoreReplies(true);
    try {
      const page = await fetchReplies(postApId(), { before: cursor });
      const seen = new Set(replies().map((r) => r.ap_id));
      setReplies((prev) => [
        ...prev,
        ...page.replies.filter((r) => !seen.has(r.ap_id)),
      ]);
      setReplyCursor(page.nextCursor);
      setReplyHasMore(page.hasMore);
    } catch {
      app.toast("返信を読み込めませんでした", "error");
    } finally {
      setLoadingMoreReplies(false);
    }
  };

  const patchLocal = (apId: string, patch: (p: Post) => Post) => {
    setPost((p) => (p && p.ap_id === apId ? patch(p) : p));
    setReplies((rs) => rs.map((r) => (r.ap_id === apId ? patch(r) : r)));
  };
  const removeLocal = (apId: string) => {
    if (post()?.ap_id === apId) {
      navigate(-1);
      return;
    }
    setReplies((rs) => rs.filter((r) => r.ap_id !== apId));
    setPost((p) =>
      p ? { ...p, reply_count: Math.max(0, p.reply_count - 1) } : p,
    );
  };

  return (
    <PageLayout>
      <PageHeader title="投稿" />
      <div class="p-page-body">
        <Show when={!loading()} fallback={<PostDetailLoading />}>
          <Show
            when={!error()}
            fallback={
              <div class="p-timeline-state">
                <p>投稿を読み込めませんでした</p>
                <button type="button" onClick={load}>
                  再読み込み
                </button>
              </div>
            }
          >
            <Show
              when={post()}
              fallback={
                <div class="p-timeline-state">
                  <p>投稿が見つかりませんでした</p>
                </div>
              }
            >
              {(detail) => (
                <>
                  <Show when={detail().in_reply_to}>
                    {(parent) => (
                      <A
                        class="p-detail-parent"
                        href={postPath(parent())}
                        aria-label="返信先の投稿を開く"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 17l-5-5 5-5" />
                          <path d="M4 12h11a4 4 0 0 1 4 4v2" />
                        </svg>
                        <span>返信先の投稿を見る</span>
                      </A>
                    )}
                  </Show>
                  <div class="p-detail-main">
                    <PostCard
                      post={detail()}
                      origin={app.origin()}
                      currentActorApId={app.actor().ap_id}
                      focused
                      onPatch={patchLocal}
                      onRemove={removeLocal}
                    />
                  </div>

                  <button
                    type="button"
                    class="p-detail-reply-open"
                    onClick={() => setReplyOpen(true)}
                  >
                    <span>{titleFor(detail().author)} に返信する</span>
                  </button>

                  <div class="p-detail-replies">
                    <For
                      each={replies()}
                      fallback={
                        <p class="p-detail-empty">まだ返信はありません</p>
                      }
                    >
                      {(reply) => (
                        <PostCard
                          post={reply}
                          origin={app.origin()}
                          currentActorApId={app.actor().ap_id}
                          onPatch={patchLocal}
                          onRemove={removeLocal}
                        />
                      )}
                    </For>
                    <Show when={replyHasMore()}>
                      <div class="p-timeline-more">
                        <button
                          type="button"
                          disabled={loadingMoreReplies()}
                          onClick={() => void loadMoreReplies()}
                        >
                          {loadingMoreReplies()
                            ? "読み込み中…"
                            : "返信をもっと見る"}
                        </button>
                      </div>
                    </Show>
                  </div>

                  <PostComposer
                    open={replyOpen()}
                    onClose={() => setReplyOpen(false)}
                    replyTo={{
                      apId: detail().ap_id,
                      author:
                        detail().author.preferred_username ||
                        detail().author.username,
                    }}
                    onPosted={(reply) => {
                      setReplies((rs) => [...rs, reply]);
                      setPost((p) =>
                        p ? { ...p, reply_count: p.reply_count + 1 } : p,
                      );
                    }}
                  />
                </>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </PageLayout>
  );
}

function PostDetailLoading() {
  return (
    <div class="p-detail-loading">
      <SpinnerIcon />
    </div>
  );
}
