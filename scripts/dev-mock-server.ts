type Actor = {
  ap_id: string;
  username: string;
  preferred_username: string;
  name: string | null;
  summary: string | null;
  icon_url: string | null;
  header_url: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  is_private?: boolean;
  role?: "owner" | "moderator" | "member";
  created_at: string;
  is_following?: boolean;
  is_followed_by?: boolean;
  fields?: { name: string; value: string }[];
  moved_to?: string | null;
  also_known_as?: string[];
};

type PostAuthor = Pick<
  Actor,
  "ap_id" | "username" | "preferred_username" | "name" | "icon_url"
>;

type Post = {
  ap_id: string;
  type: "Note";
  author: PostAuthor;
  content: string;
  summary: string | null;
  attachments: {
    url?: string;
    r2_key: string;
    content_type: string;
    name?: string;
  }[];
  in_reply_to: string | null;
  visibility: "public" | "unlisted" | "followers" | "direct";
  community_ap_id: string | null;
  like_count: number;
  reply_count: number;
  announce_count: number;
  published: string;
  edited_at: string | null;
  liked: boolean;
  bookmarked: boolean;
  reposted: boolean;
};

type CommunityDetail = {
  ap_id: string;
  name: string;
  display_name: string;
  preferred_username: string;
  summary: string | null;
  icon_url: string | null;
  visibility: "public" | "private";
  join_policy: "open" | "invite" | "approval";
  post_policy: "anyone" | "members" | "mods" | "owners";
  member_count: number;
  post_count: number;
  created_by: string;
  created_at: string;
  is_member: boolean;
  member_role: "owner" | "moderator" | "member" | null;
  join_status?: "pending" | null;
  last_message_at?: string | null;
};

type DMContact = {
  type: "user" | "community";
  ap_id: string;
  username: string;
  preferred_username: string;
  name: string | null;
  icon_url: string | null;
  conversation_id?: string | null;
  member_count?: number;
  last_message: { content: string; is_mine: boolean } | null;
  last_message_at: string | null;
  unread_count?: number;
};

type Message = {
  id: string;
  sender: PostAuthor;
  content: string;
  created_at: string;
};

type ActorNote = {
  actor: PostAuthor;
  content: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  is_mine: boolean;
};

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const origin =
  process.env.YURUCOMMU_MOCK_ORIGIN ?? "https://mock.yurucommu.test";
const mockImageUrl =
  process.env.YURUCOMMU_MOCK_IMAGE_URL ??
  "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80";

let signedIn = process.env.YURUCOMMU_MOCK_AUTH !== "signed-out";

function actor(
  preferredUsername: string,
  name: string,
  summary: string,
  options: Partial<Actor> = {},
): Actor {
  return {
    ap_id: `${origin}/ap/users/${preferredUsername}`,
    username: `${preferredUsername}@mock.yurucommu.test`,
    preferred_username: preferredUsername,
    name,
    summary,
    icon_url: `https://api.dicebear.com/9.x/thumbs/svg?seed=${preferredUsername}`,
    header_url: mockImageUrl,
    follower_count: 128,
    following_count: 86,
    post_count: 24,
    created_at: "2026-07-01T09:00:00.000Z",
    is_following: false,
    is_followed_by: false,
    also_known_as: [],
    ...options,
  };
}

function postAuthor(actorData: Actor): PostAuthor {
  return {
    ap_id: actorData.ap_id,
    username: actorData.username,
    preferred_username: actorData.preferred_username,
    name: actorData.name,
    icon_url: actorData.icon_url,
  };
}

const me = actor("you", "You", "UI development mock account.", {
  follower_count: 240,
  following_count: 178,
  post_count: 42,
  is_following: true,
});
const akari = actor("akari", "Akari", "Talks about small community tools.", {
  is_followed_by: true,
  is_following: true,
});
const ren = actor("ren", "Ren", "Design and product notes.", {
  is_followed_by: true,
  is_following: true,
});
const mio = actor("mio", "Mio", "Federated social UI experiments.", {
  is_followed_by: false,
  is_following: false,
});
const blockedSample = actor("spammer", "Spam Bot", "Blocked account sample.");
const mutedSample = actor("noisy", "Noisy Poster", "Muted account sample.");

let actors = [me, akari, ren, mio];

const communities: CommunityDetail[] = [
  {
    ap_id: `${origin}/ap/groups/kissa-builders`,
    name: "kissa-builders",
    display_name: "Kissa Builders",
    preferred_username: "kissa-builders",
    summary: "A small room for product, UI, and community ideas.",
    icon_url: "https://api.dicebear.com/9.x/shapes/svg?seed=kissa-builders",
    visibility: "public",
    join_policy: "open",
    post_policy: "members",
    member_count: 34,
    post_count: 12,
    created_by: me.ap_id,
    created_at: "2026-07-01T10:00:00.000Z",
    is_member: true,
    member_role: "owner",
    last_message_at: "2026-07-05T05:40:00.000Z",
  },
  {
    ap_id: `${origin}/ap/groups/night-ship`,
    name: "night-ship",
    display_name: "Night Ship",
    preferred_username: "night-ship",
    summary: "Loose evening updates and story checks.",
    icon_url: "https://api.dicebear.com/9.x/shapes/svg?seed=night-ship",
    visibility: "private",
    join_policy: "approval",
    post_policy: "members",
    member_count: 12,
    post_count: 7,
    created_by: ren.ap_id,
    created_at: "2026-07-02T14:00:00.000Z",
    is_member: true,
    member_role: "member",
    last_message_at: "2026-07-05T04:35:00.000Z",
  },
  {
    ap_id: `${origin}/ap/groups/dawn-readers`,
    name: "dawn-readers",
    display_name: "Dawn Readers",
    preferred_username: "dawn-readers",
    summary: "Morning reading club — open to anyone.",
    icon_url: "https://api.dicebear.com/9.x/shapes/svg?seed=dawn-readers",
    visibility: "public",
    join_policy: "open",
    post_policy: "members",
    member_count: 58,
    post_count: 40,
    created_by: akari.ap_id,
    created_at: "2026-07-03T09:00:00.000Z",
    is_member: false,
    member_role: null,
    last_message_at: "2026-07-05T06:00:00.000Z",
  },
  {
    ap_id: `${origin}/ap/groups/studio-hush`,
    name: "studio-hush",
    display_name: "Studio Hush",
    preferred_username: "studio-hush",
    summary: "Invite-only design critiques.",
    icon_url: "https://api.dicebear.com/9.x/shapes/svg?seed=studio-hush",
    visibility: "private",
    join_policy: "invite",
    post_policy: "members",
    member_count: 6,
    post_count: 3,
    created_by: ren.ap_id,
    created_at: "2026-07-04T11:00:00.000Z",
    is_member: false,
    member_role: null,
    last_message_at: null,
  },
];

let posts: Post[] = [
  {
    ap_id: `${origin}/ap/notes/post-1`,
    type: "Note",
    author: postAuthor(akari),
    content:
      "Mock server is online. Timeline, stories, DMs, and communities are all local data.",
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 18,
    reply_count: 3,
    announce_count: 2,
    published: "2026-07-05T05:20:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  },
  {
    ap_id: `${origin}/ap/notes/post-2`,
    type: "Note",
    author: postAuthor(ren),
    content:
      "Yurumeet should feel like a talk-first client on the same yurucommu server.",
    summary: null,
    attachments: [
      {
        url: mockImageUrl,
        r2_key: "mock/ui-reference.jpg",
        content_type: "image/jpeg",
        name: "Mock UI reference",
      },
    ],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: communities[0].ap_id,
    like_count: 31,
    reply_count: 6,
    announce_count: 4,
    published: "2026-07-05T04:45:00.000Z",
    edited_at: null,
    liked: true,
    bookmarked: true,
    reposted: false,
  },
  {
    ap_id: `${origin}/ap/notes/post-3`,
    type: "Note",
    author: postAuthor(mio),
    content:
      "Spoiler-y detail about the ending is hidden behind this content warning.",
    summary: "ネタバレ注意",
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 9,
    reply_count: 1,
    announce_count: 0,
    published: "2026-07-05T04:10:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  },
  {
    ap_id: `${origin}/ap/notes/post-4`,
    type: "Note",
    author: postAuthor(akari),
    content:
      "Read the write-up at https://yurucommu.example/notes thanks @ren #yurumeet #talkfirst",
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 5,
    reply_count: 0,
    announce_count: 1,
    published: "2026-07-05T03:30:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  },
  {
    ap_id: `${origin}/ap/notes/post-5`,
    type: "Note",
    author: postAuthor(ren),
    content: "Short screen capture of the talk pane sliding in on mobile.",
    summary: null,
    attachments: [
      {
        url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
        r2_key: "mock/talk-pane.mp4",
        content_type: "video/mp4",
        name: "Talk pane demo",
      },
    ],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 12,
    reply_count: 2,
    announce_count: 3,
    published: "2026-07-05T02:50:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  },
  ...Array.from({ length: 8 }, (_, i) => ({
    ap_id: `${origin}/ap/notes/post-fill-${i + 1}`,
    type: "Note" as const,
    author: postAuthor(i % 2 === 0 ? akari : ren),
    content: `Older mock post #${i + 1} — kept around so the timeline has enough history to paginate.`,
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public" as const,
    community_ap_id: null,
    like_count: i,
    reply_count: 0,
    announce_count: 0,
    published: new Date(Date.UTC(2026, 6, 4, 23 - i)).toISOString(),
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  })),
];

function seedReply(
  parentApId: string,
  author: Actor,
  content: string,
  minutesAgo: number,
): Post {
  return {
    ap_id: `${origin}/ap/notes/reply-${parentApId.split("/").pop()}-${minutesAgo}`,
    type: "Note",
    author: postAuthor(author),
    content,
    summary: null,
    attachments: [],
    in_reply_to: parentApId,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: new Date(Date.UTC(2026, 6, 5, 5, 30 - minutesAgo)).toISOString(),
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
}

const repliesByParent: Record<string, Post[]> = {
  [`${origin}/ap/notes/post-1`]: [
    seedReply(
      `${origin}/ap/notes/post-1`,
      ren,
      "Nice, the mock feels real.",
      25,
    ),
    seedReply(
      `${origin}/ap/notes/post-1`,
      mio,
      "Replies render in a thread.",
      20,
    ),
    seedReply(`${origin}/ap/notes/post-1`, akari, "And they paginate too.", 15),
    seedReply(
      `${origin}/ap/notes/post-1`,
      ren,
      "Tap one to see its parent.",
      10,
    ),
    seedReply(
      `${origin}/ap/notes/post-1`,
      mio,
      "Good for testing detail view.",
      5,
    ),
  ],
};
posts[0].reply_count = 5;
const readConversations = new Set<string>();
const readNotifications = new Set<string>();
const archivedNotifications = new Set<string>();
const archivedUsers = new Set<string>();
let dmRequests = [
  {
    id: "request-1",
    sender: postAuthor(mio),
    content: "Can I send you a mock UI note?",
    created_at: "2026-07-05T02:30:00.000Z",
  },
];
const UNREAD_NOTIF_IDS = ["notif-req", "notif-story", "notif-1", "notif-reply"];

let userMessages: Record<string, Message[]> = {
  [akari.ap_id]: [
    {
      id: "dm-1",
      sender: postAuthor(akari),
      content: "Mock auth is the same as yurucommu.",
      created_at: "2026-07-05T05:00:00.000Z",
    },
    {
      id: "dm-2",
      sender: postAuthor(me),
      content: "Good. I want to debug the client UI without a backend.",
      created_at: "2026-07-05T05:02:00.000Z",
    },
  ],
  [ren.ap_id]: [
    {
      id: "dm-3",
      sender: postAuthor(ren),
      content: "The talk tab is using the same DM endpoints.",
      created_at: "2026-07-05T04:30:00.000Z",
    },
  ],
};

let communityMessages: Record<string, Message[]> = {
  [communities[0].ap_id]: [
    {
      id: "cm-1",
      sender: postAuthor(ren),
      content: "The mock community chat is ready for UI work.",
      created_at: "2026-07-05T05:40:00.000Z",
    },
    {
      id: "cm-2",
      sender: postAuthor(akari),
      content: "Stories and timeline data are mocked too.",
      created_at: "2026-07-05T05:42:00.000Z",
    },
  ],
  [communities[1].ap_id]: [
    {
      id: "cm-3",
      sender: postAuthor(mio),
      content: "Private room data keeps the sidebars populated.",
      created_at: "2026-07-05T04:35:00.000Z",
    },
  ],
};

let notes: ActorNote[] = [
  {
    actor: postAuthor(me),
    content: "UIを詰めてる",
    created_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    is_mine: true,
  },
  {
    actor: postAuthor(akari),
    content: "あとで写真送る",
    created_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
    is_mine: false,
  },
  {
    actor: postAuthor(ren),
    content: "talk-first案ある",
    created_at: new Date(Date.now() - 78 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 78 * 60 * 1000).toISOString(),
    expires_at: new Date(Date.now() + 22 * 60 * 60 * 1000).toISOString(),
    is_mine: false,
  },
];

function headers(request: Request, contentType = "application/json"): Headers {
  const result = new Headers({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin) result.set("Access-Control-Allow-Origin", requestOrigin);
  if (contentType) result.set("Content-Type", `${contentType}; charset=utf-8`);
  return result;
}

function json(
  request: Request,
  data: JsonValue,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: headers(request),
  });
}

function empty(request: Request, status = 204): Response {
  return new Response(null, { status, headers: headers(request, "") });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathBetween(path: string, prefix: string, suffix = ""): string | null {
  if (!path.startsWith(prefix)) return null;
  if (suffix && !path.endsWith(suffix)) return null;
  const end = suffix ? path.length - suffix.length : path.length;
  const raw = path.slice(prefix.length, end);
  if (!raw || raw.includes("/")) return null;
  return decodePathPart(raw);
}

function findActor(identifier: string): Actor {
  const clean = identifier.replace(/^@/, "");
  return (
    actors.find(
      (candidate) =>
        candidate.ap_id === identifier ||
        candidate.username === clean ||
        candidate.preferred_username === clean ||
        candidate.username === identifier,
    ) ?? me
  );
}

function findCommunity(identifier: string): CommunityDetail {
  return (
    communities.find(
      (community) =>
        community.ap_id === identifier ||
        community.name === identifier ||
        community.preferred_username === identifier,
    ) ?? communities[0]
  );
}

function userContact(actorData: Actor, index: number): DMContact {
  const messages = userMessages[actorData.ap_id] ?? [];
  const last = messages.at(-1);
  return {
    type: "user",
    ap_id: actorData.ap_id,
    username: actorData.username,
    preferred_username: actorData.preferred_username,
    name: actorData.name,
    icon_url: actorData.icon_url,
    conversation_id: `conv-${actorData.preferred_username}`,
    last_message: last
      ? { content: last.content, is_mine: last.sender.ap_id === me.ap_id }
      : null,
    last_message_at: last?.created_at ?? null,
    unread_count: readConversations.has(actorData.ap_id)
      ? 0
      : index === 0
        ? 2
        : 0,
  };
}

function communityContact(
  community: CommunityDetail,
  index: number,
): DMContact {
  const messages = communityMessages[community.ap_id] ?? [];
  const last = messages.at(-1);
  return {
    type: "community",
    ap_id: community.ap_id,
    username: `${community.name}@mock.yurucommu.test`,
    preferred_username: community.preferred_username,
    name: community.display_name,
    icon_url: community.icon_url,
    conversation_id: `community-${community.name}`,
    member_count: community.member_count,
    last_message: last
      ? { content: last.content, is_mine: last.sender.ap_id === me.ap_id }
      : null,
    last_message_at: last?.created_at ?? community.last_message_at ?? null,
    unread_count: readConversations.has(community.ap_id)
      ? 0
      : index === 0
        ? 1
        : 0,
  };
}

function timelineResponse(url: URL): JsonValue {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 90);
  const before = url.searchParams.get("before");
  const ordered = [...posts].sort((a, b) =>
    a.published < b.published ? 1 : a.published > b.published ? -1 : 0,
  );
  const start = before
    ? ordered.findIndex((post) => post.published < before)
    : 0;
  const from = start < 0 ? ordered.length : start;
  const page = ordered.slice(from, from + limit);
  const last = page[page.length - 1];
  const hasMore = from + limit < ordered.length;
  return {
    posts: page,
    next_cursor: hasMore && last ? last.published : null,
    has_more: hasMore,
  };
}

type StoryEntry = {
  ap_id: string;
  author: PostAuthor;
  attachment: Record<string, JsonValue>;
  caption: string;
  displayDuration: string;
  overlays: JsonValue[];
  published: string;
  end_time: string;
  viewed: boolean;
  like_count: number;
  share_count: number;
  liked: boolean;
};

function storyImage(key: string): Record<string, JsonValue> {
  return {
    type: "Document",
    mediaType: "image/jpeg",
    url: mockImageUrl,
    r2_key: key,
    width: 1080,
    height: 1920,
  };
}

let ownStories: StoryEntry[] = [
  {
    ap_id: `${origin}/ap/stories/story-me-1`,
    author: postAuthor(me),
    attachment: storyImage("mock/story-me-1.jpg"),
    caption: "My first mock story.",
    displayDuration: "PT6S",
    overlays: [],
    published: "2026-07-05T05:45:00.000Z",
    end_time: "2026-07-06T05:45:00.000Z",
    viewed: true,
    like_count: 2,
    share_count: 0,
    liked: false,
  },
  {
    ap_id: `${origin}/ap/stories/story-me-2`,
    author: postAuthor(me),
    attachment: storyImage("mock/story-me-2.jpg"),
    caption: "Second one so the progress bar has segments.",
    displayDuration: "PT6S",
    overlays: [],
    published: "2026-07-05T05:50:00.000Z",
    end_time: "2026-07-06T05:50:00.000Z",
    viewed: true,
    like_count: 1,
    share_count: 0,
    liked: false,
  },
];

const otherStoryGroups = () => [
  {
    actor: postAuthor(akari),
    has_unviewed: true,
    stories: [
      {
        ap_id: `${origin}/ap/stories/story-1`,
        author: postAuthor(akari),
        attachment: storyImage("mock/story-1.jpg"),
        caption: "Mock story for UI layout checks.",
        displayDuration: "PT6S",
        overlays: [],
        published: "2026-07-05T05:05:00.000Z",
        end_time: "2026-07-06T05:05:00.000Z",
        viewed: false,
        like_count: 4,
        share_count: 1,
        liked: false,
      },
    ],
  },
  {
    actor: postAuthor(ren),
    has_unviewed: false,
    stories: [
      {
        ap_id: `${origin}/ap/stories/story-2`,
        author: postAuthor(ren),
        attachment: storyImage("mock/story-2.jpg"),
        caption: "Talk-first client, same server.",
        displayDuration: "PT6S",
        overlays: [],
        published: "2026-07-05T04:15:00.000Z",
        end_time: "2026-07-06T04:15:00.000Z",
        viewed: true,
        like_count: 7,
        share_count: 2,
        liked: true,
      },
    ],
  },
];

function storiesResponse(): JsonValue {
  const groups: JsonValue[] = [];
  if (ownStories.length > 0) {
    groups.push({
      actor: postAuthor(me),
      has_unviewed: ownStories.some((s) => !s.viewed),
      stories: ownStories,
    });
  }
  groups.push(...otherStoryGroups());
  return { actor_stories: groups };
}

const notificationItems: JsonValue[] = [
  {
    id: "notif-req",
    type: "follow_request",
    actor: postAuthor(mio),
    object_ap_id: null,
    read: false,
    created_at: "2026-07-05T05:55:00.000Z",
  },
  {
    id: "notif-story",
    type: "like",
    actor: postAuthor(ren),
    object_ap_id: `${origin}/ap/stories/story-you`,
    target_kind: "story",
    target_id: `${origin}/ap/stories/story-you`,
    target_url: `/?story=${encodeURIComponent(`${origin}/ap/stories/story-you`)}`,
    read: false,
    created_at: "2026-07-05T05:40:00.000Z",
  },
  {
    id: "notif-1",
    type: "like",
    actor: postAuthor(akari),
    object_ap_id: posts[0].ap_id,
    read: false,
    created_at: "2026-07-05T05:25:00.000Z",
  },
  {
    id: "notif-reply",
    type: "reply",
    actor: postAuthor(ren),
    object_ap_id: posts[0].ap_id,
    read: false,
    created_at: "2026-07-05T05:10:00.000Z",
  },
  {
    id: "notif-boost",
    type: "announce",
    actor: postAuthor(akari),
    object_ap_id: posts[1].ap_id,
    read: true,
    created_at: "2026-07-05T04:30:00.000Z",
  },
  {
    id: "notif-mention",
    type: "mention",
    actor: postAuthor(ren),
    object_ap_id: posts[1].ap_id,
    read: true,
    created_at: "2026-07-05T04:05:00.000Z",
  },
  {
    id: "notif-2",
    type: "follow",
    actor: postAuthor(mio),
    object_ap_id: null,
    read: true,
    created_at: "2026-07-05T03:40:00.000Z",
  },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `notif-like-${i + 1}`,
    type: "like",
    actor: postAuthor(i % 2 === 0 ? ren : akari),
    object_ap_id: posts[0].ap_id,
    read: true,
    created_at: new Date(Date.UTC(2026, 6, 5, 3, 30 - i)).toISOString(),
  })),
];

function notificationsResponse(url: URL): JsonValue {
  const type = url.searchParams.get("type");
  const before = url.searchParams.get("before");
  const archived = url.searchParams.get("archived") === "true";
  const pageSize = 8;
  const filtered = notificationItems.filter(
    (n) =>
      archivedNotifications.has((n as { id: string }).id) === archived &&
      (!type ||
        type === "all" ||
        (n as { type: string }).type === type ||
        // the "follow" tab also surfaces pending follow requests
        (type === "follow" &&
          (n as { type: string }).type === "follow_request")),
  );
  const start = before
    ? filtered.findIndex(
        (n) => (n as { created_at: string }).created_at < before,
      )
    : 0;
  const from = start < 0 ? filtered.length : start;
  const page = filtered.slice(from, from + pageSize).map((notification) => ({
    ...(notification as Record<string, JsonValue>),
    read:
      (notification as { read: boolean }).read ||
      readNotifications.has((notification as { id: string }).id),
  }));
  const last = page[page.length - 1] as unknown as
    { created_at: string } | undefined;
  const hasMore = from + pageSize < filtered.length;
  return {
    notifications: page,
    has_more: hasMore,
    next_cursor: hasMore && last ? last.created_at : null,
  };
}

function notesResponse(): JsonValue {
  const now = new Date().toISOString();
  return {
    notes: notes.filter((note) => note.expires_at > now),
  };
}

function discovery(request: Request): JsonValue {
  const apiBaseUrl = new URL(request.url).origin;
  return {
    product: "yurucommu",
    name: "Yurucommu Mock Server",
    server: {
      id: "yurucommu-server",
      name: "Yurucommu Mock Server",
      canonicalOrigin: apiBaseUrl,
      activitypubOrigin: origin,
    },
    clients: [
      { id: "yurucommu", name: "Yurucommu", defaultEntry: "feed" },
      { id: "yurume", name: "Yurumeet", defaultEntry: "messages" },
    ],
    issuer: apiBaseUrl,
    apiBaseUrl,
    activitypubOrigin: origin,
    mediaOrigin: apiBaseUrl,
    socialServerCapabilitiesUrl: `${apiBaseUrl}/.well-known/social-server`,
    capabilities: [
      "auth.password",
      "timeline",
      "stories",
      "notes",
      "dm",
      "communities",
    ],
    endpoints: {
      api: `${apiBaseUrl}/api`,
      authProviders: `${apiBaseUrl}/api/auth/providers`,
      currentUser: `${apiBaseUrl}/api/auth/me`,
      timeline: `${apiBaseUrl}/api/timeline`,
      notes: `${apiBaseUrl}/api/notes`,
      conversations: `${apiBaseUrl}/api/dm/contacts`,
      notifications: `${apiBaseUrl}/api/notifications`,
      notificationPushers: `${apiBaseUrl}/api/notifications/pushers`,
      mobilePushRegistrations: `${apiBaseUrl}/api/mobile/push/registrations`,
    },
  };
}

function ok(): JsonValue {
  return { success: true };
}

async function handleAuth(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/api/auth/providers") {
    return json(request, { providers: [], password_enabled: true });
  }
  if (method === "GET" && path === "/api/auth/me") {
    if (!signedIn)
      return json(request, { error: "signed_out" }, { status: 401 });
    return json(request, { actor: me });
  }
  if (method === "POST" && path === "/api/auth/login") {
    signedIn = true;
    await readJson(request);
    const response = json(request, ok());
    response.headers.append(
      "Set-Cookie",
      "session=mock-session; Path=/; HttpOnly; SameSite=Lax",
    );
    return response;
  }
  if (method === "POST" && path === "/api/auth/logout") {
    signedIn = false;
    const response = json(request, ok());
    response.headers.append(
      "Set-Cookie",
      "session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    );
    return response;
  }
  if (method === "GET" && path === "/api/auth/accounts") {
    return json(request, {
      accounts: actors.slice(0, 2).map((account) => ({
        ap_id: account.ap_id,
        preferred_username: account.preferred_username,
        name: account.name,
        icon_url: account.icon_url,
      })),
      current_ap_id: me.ap_id,
    });
  }
  if (method === "POST" && path === "/api/auth/switch") {
    await readJson(request);
    return json(request, ok());
  }
  if (method === "POST" && path === "/api/auth/accounts") {
    const body = await readJson(request);
    const username =
      typeof body.username === "string" ? body.username : `mock-${Date.now()}`;
    const created = actor(
      username,
      String(body.name ?? username),
      "Mock account",
    );
    actors = [created, ...actors];
    return json(request, {
      account: {
        ap_id: created.ap_id,
        preferred_username: created.preferred_username,
        name: created.name,
        icon_url: created.icon_url,
      },
    });
  }
  return null;
}

async function handleDm(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  const userMessageId = pathBetween(path, "/api/dm/user/", "/messages");
  if (userMessageId) {
    const actorData = findActor(userMessageId);
    if (method === "GET") {
      return json(request, {
        messages: userMessages[actorData.ap_id] ?? [],
        conversation_id: `conv-${actorData.preferred_username}`,
        has_more: false,
      });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const message: Message = {
        id: `dm-${Date.now()}`,
        sender: postAuthor(me),
        content: typeof body.content === "string" ? body.content : "",
        created_at: new Date().toISOString(),
      };
      userMessages[actorData.ap_id] = [
        ...(userMessages[actorData.ap_id] ?? []),
        message,
      ];
      return json(request, {
        message,
        conversation_id: `conv-${actorData.preferred_username}`,
      });
    }
  }

  const userTypingId = pathBetween(path, "/api/dm/user/", "/typing");
  if (userTypingId) {
    return method === "GET"
      ? json(request, { is_typing: false, last_typed_at: null })
      : json(request, ok());
  }

  const userReadId = pathBetween(path, "/api/dm/user/", "/read");
  if (userReadId && method === "POST") {
    readConversations.add(userReadId);
    return json(request, ok());
  }

  const userArchiveId = pathBetween(path, "/api/dm/user/", "/archive");
  if (userArchiveId && method === "POST") {
    archivedUsers.add(userArchiveId);
    return json(request, ok());
  }
  if (userArchiveId && method === "DELETE") {
    archivedUsers.delete(userArchiveId);
    return json(request, ok());
  }

  const communityReadId = pathBetween(path, "/api/dm/community/", "/read");
  if (communityReadId && method === "POST") {
    readConversations.add(communityReadId);
    return json(request, ok());
  }

  const contactId = pathBetween(path, "/api/dm/contact/");
  if (contactId && method === "GET") {
    const community = communities.find((item) => item.ap_id === contactId);
    const actorData = actors.find((item) => item.ap_id === contactId);
    if (community)
      return json(request, { contact: communityContact(community, 0) });
    if (actorData) return json(request, { contact: userContact(actorData, 0) });
    return json(request, { error: "not_found" }, { status: 404 });
  }

  if (method === "GET" && path === "/api/dm/contacts") {
    return json(request, {
      mutual_followers: [akari, ren]
        .filter((actorData) => !archivedUsers.has(actorData.ap_id))
        .map(userContact),
      communities: communities
        .filter((community) => community.is_member)
        .map(communityContact),
      request_count: dmRequests.length,
    });
  }
  if (method === "GET" && path === "/api/dm/unread/count") {
    const dm = readConversations.has(akari.ap_id) ? 0 : 2;
    const community = readConversations.has(communities[0]?.ap_id ?? "")
      ? 0
      : 1;
    return json(request, { total: dm + community, dm, community });
  }
  if (method === "GET" && path === "/api/dm/requests") {
    return json(request, { requests: dmRequests });
  }
  if (method === "POST" && path === "/api/dm/requests/reject") {
    const body = await readJson(request);
    if (typeof body.sender_ap_id === "string") {
      dmRequests = dmRequests.filter(
        (req) => req.sender.ap_id !== body.sender_ap_id,
      );
    }
    return json(request, ok());
  }
  if (method === "GET" && path === "/api/dm/archived") {
    const archived = [akari, ren]
      .filter((actorData) => archivedUsers.has(actorData.ap_id))
      .map((actorData) => ({
        ...postAuthor(actorData),
        conversation_id: `conv-${actorData.preferred_username}`,
        last_message_at: null,
      }));
    return json(request, { archived });
  }
  return null;
}

async function handleCommunities(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/api/communities") {
    return json(request, { communities });
  }
  if (method === "POST" && path === "/api/communities") {
    const body = await readJson(request);
    const name =
      typeof body.name === "string" ? body.name : `room-${Date.now()}`;
    const created: CommunityDetail = {
      ap_id: `${origin}/ap/groups/${name}`,
      name,
      preferred_username: name,
      display_name:
        typeof body.display_name === "string" ? body.display_name : name,
      summary: typeof body.summary === "string" ? body.summary : null,
      icon_url: `https://api.dicebear.com/9.x/shapes/svg?seed=${name}`,
      visibility: "public",
      join_policy: "open",
      post_policy: "members",
      member_count: 1,
      post_count: 0,
      created_by: me.ap_id,
      created_at: new Date().toISOString(),
      is_member: true,
      member_role: "owner",
      last_message_at: null,
    };
    communities.unshift(created);
    communityMessages[created.ap_id] = [];
    return json(request, { community: created });
  }

  const messageId = pathBetween(path, "/api/communities/", "/messages");
  if (messageId) {
    const community = findCommunity(messageId);
    if (method === "GET") {
      return json(request, {
        messages: communityMessages[community.ap_id] ?? [],
        has_more: false,
      });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const message: Message = {
        id: `cm-${Date.now()}`,
        sender: postAuthor(me),
        content: typeof body.content === "string" ? body.content : "",
        created_at: new Date().toISOString(),
      };
      communityMessages[community.ap_id] = [
        ...(communityMessages[community.ap_id] ?? []),
        message,
      ];
      community.last_message_at = message.created_at;
      return json(request, { message });
    }
  }

  const msgDeleteMatch = path.match(
    /^\/api\/communities\/(.+)\/messages\/([^/]+)$/,
  );
  if (msgDeleteMatch && method === "DELETE") {
    const communityKey = decodePathPart(msgDeleteMatch[1]);
    const messageId = decodePathPart(msgDeleteMatch[2]);
    const community = findCommunity(communityKey);
    communityMessages[community.ap_id] = (
      communityMessages[community.ap_id] ?? []
    ).filter((m) => m.id !== messageId);
    return json(request, ok());
  }

  const membersId = pathBetween(path, "/api/communities/", "/members");
  if (membersId && method === "GET") {
    return json(request, {
      members: [me, akari, ren].map((member, index) => ({
        ...postAuthor(member),
        role: index === 0 ? "owner" : "member",
        joined_at: "2026-07-01T10:00:00.000Z",
      })),
    });
  }

  if (
    path.includes("/members/") &&
    (method === "PATCH" || method === "DELETE")
  ) {
    await readJson(request);
    return json(request, ok());
  }

  const requestsId = pathBetween(path, "/api/communities/", "/requests");
  if (requestsId && method === "GET") {
    return json(request, {
      requests: [
        {
          ...postAuthor(mio),
          created_at: "2026-07-05T02:10:00.000Z",
        },
      ],
    });
  }

  if (
    (path.endsWith("/requests/accept") || path.endsWith("/requests/reject")) &&
    method === "POST"
  ) {
    await readJson(request);
    return json(request, ok());
  }

  const invitesId = pathBetween(path, "/api/communities/", "/invites");
  if (invitesId && method === "GET") {
    return json(request, {
      invites: [
        {
          id: "invite-1",
          invited_ap_id: null,
          invited_by: postAuthor(me),
          created_at: "2026-07-05T01:00:00.000Z",
          expires_at: null,
          used_at: null,
          used_by_ap_id: null,
          is_valid: true,
        },
      ],
    });
  }
  if (invitesId && method === "POST") {
    await readJson(request);
    return json(request, {
      invite_id: `invite-${Date.now()}`,
      expires_at: null,
    });
  }
  if (path.includes("/invites/") && method === "DELETE") {
    return json(request, ok());
  }

  const settingsId = pathBetween(path, "/api/communities/", "/settings");
  if (settingsId && method === "PATCH") {
    await readJson(request);
    return json(request, ok());
  }

  const joinId = pathBetween(path, "/api/communities/", "/join");
  if (joinId && method === "POST") {
    const community = findCommunity(joinId);
    if (community.join_policy === "invite") {
      return json(request, { status: "invite_required" });
    }
    if (community.join_policy === "approval") {
      community.join_status = "pending";
      return json(request, { status: "pending" });
    }
    community.is_member = true;
    community.member_role = "member";
    community.member_count += 1;
    return json(request, { status: "joined" });
  }

  const leaveId = pathBetween(path, "/api/communities/", "/leave");
  if (leaveId && method === "POST") {
    const community = findCommunity(leaveId);
    if (community.is_member) {
      community.is_member = false;
      community.member_role = null;
      community.member_count = Math.max(0, community.member_count - 1);
    }
    return json(request, ok());
  }

  const communityId = pathBetween(path, "/api/communities/");
  if (communityId && method === "GET") {
    return json(request, { community: findCommunity(communityId) });
  }

  return null;
}

async function handlePosts(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/api/timeline") {
    return json(request, timelineResponse(new URL(request.url)));
  }
  if (method === "GET" && path === "/api/bookmarks") {
    return json(request, {
      posts: posts.filter((post) => post.bookmarked),
      next_cursor: null,
      has_more: false,
    });
  }
  if (method === "POST" && path === "/api/posts") {
    const body = await readJson(request);
    const created: Post = {
      ap_id: `${origin}/ap/notes/post-${Date.now()}`,
      type: "Note",
      author: postAuthor(me),
      content: typeof body.content === "string" ? body.content : "",
      summary: typeof body.summary === "string" ? body.summary : null,
      attachments: [],
      in_reply_to:
        typeof body.in_reply_to === "string" ? body.in_reply_to : null,
      visibility: "public",
      community_ap_id:
        typeof body.community_ap_id === "string" ? body.community_ap_id : null,
      like_count: 0,
      reply_count: 0,
      announce_count: 0,
      published: new Date().toISOString(),
      edited_at: null,
      liked: false,
      bookmarked: false,
      reposted: false,
    };
    if (created.in_reply_to) {
      const list = repliesByParent[created.in_reply_to] ?? [];
      repliesByParent[created.in_reply_to] = [...list, created];
      const parent = posts.find((p) => p.ap_id === created.in_reply_to);
      if (parent) parent.reply_count += 1;
    } else {
      posts = [created, ...posts];
    }
    return json(request, { post: created });
  }

  const repliesId = pathBetween(path, "/api/posts/", "/replies");
  if (repliesId && method === "GET") {
    const pageSize = 3;
    const before = new URL(request.url).searchParams.get("before");
    const all = [...(repliesByParent[repliesId] ?? [])].sort((a, b) =>
      a.published < b.published ? -1 : a.published > b.published ? 1 : 0,
    );
    const start = before
      ? all.findIndex((reply) => reply.published > before)
      : 0;
    const from = start < 0 ? all.length : start;
    const page = all.slice(from, from + pageSize);
    const last = page[page.length - 1];
    const hasMore = from + pageSize < all.length;
    return json(request, {
      replies: page,
      next_cursor: hasMore && last ? last.published : null,
      has_more: hasMore,
    });
  }

  for (const action of ["like", "repost", "bookmark"] as const) {
    const actionId = pathBetween(path, "/api/posts/", `/${action}`);
    if (actionId && (method === "POST" || method === "DELETE")) {
      const post = posts.find((item) => item.ap_id === actionId) ?? posts[0];
      if (action === "like") {
        post.liked = method === "POST";
        post.like_count = Math.max(
          0,
          post.like_count + (method === "POST" ? 1 : -1),
        );
      }
      if (action === "repost") {
        post.reposted = method === "POST";
        post.announce_count = Math.max(
          0,
          post.announce_count + (method === "POST" ? 1 : -1),
        );
      }
      if (action === "bookmark") post.bookmarked = method === "POST";
      return json(request, ok());
    }
  }

  const allPosts = () => [...posts, ...Object.values(repliesByParent).flat()];
  const postId = pathBetween(path, "/api/posts/");
  if (postId && method === "GET") {
    return json(request, {
      post: allPosts().find((post) => post.ap_id === postId) ?? posts[0],
    });
  }
  if (postId && method === "PATCH") {
    const body = await readJson(request);
    const post = posts.find((item) => item.ap_id === postId) ?? posts[0];
    post.content =
      typeof body.content === "string" ? body.content : post.content;
    if ("summary" in body) {
      post.summary = typeof body.summary === "string" ? body.summary : null;
    }
    post.edited_at = new Date().toISOString();
    return json(request, { post });
  }
  if (postId && method === "DELETE") {
    posts = posts.filter((post) => post.ap_id !== postId);
    return json(request, ok());
  }
  return null;
}

async function handleNotes(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/api/notes") {
    return json(request, notesResponse());
  }
  if (method === "POST" && path === "/api/notes") {
    const body = await readJson(request);
    const content =
      typeof body.content === "string" ? body.content.trim().slice(0, 80) : "";
    if (!content) {
      return json(
        request,
        { error: "content must be 1-80 characters" },
        { status: 400 },
      );
    }
    const now = new Date().toISOString();
    const note: ActorNote = {
      actor: postAuthor(me),
      content,
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      is_mine: true,
    };
    notes = [note, ...notes.filter((item) => !item.is_mine)];
    return json(request, { note }, { status: 201 });
  }
  if (method === "DELETE" && path === "/api/notes/me") {
    notes = notes.filter((note) => !note.is_mine);
    return json(request, ok());
  }
  return null;
}

async function handleStories(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/api/stories") {
    return json(request, storiesResponse());
  }
  if (method === "POST" && path === "/api/stories") {
    await readJson(request);
    return json(request, {
      story: {
        ap_id: `${origin}/ap/stories/story-${Date.now()}`,
        author: postAuthor(me),
        attachment: {
          type: "Document",
          mediaType: "image/jpeg",
          url: mockImageUrl,
          r2_key: "mock/uploaded-story.jpg",
        },
        displayDuration: "PT6S",
        overlays: [],
        published: new Date().toISOString(),
        end_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        viewed: false,
      },
    });
  }
  if (method === "POST" && path === "/api/stories/delete") {
    const body = await readJson(request);
    if (typeof body.ap_id === "string") {
      ownStories = ownStories.filter((story) => story.ap_id !== body.ap_id);
    }
    return json(request, ok());
  }
  if (
    method === "POST" &&
    ["/api/stories/view", "/api/stories/vote"].includes(path)
  ) {
    await readJson(request);
    return json(request, ok());
  }

  const likeId = pathBetween(path, "/api/stories/", "/like");
  if (likeId && (method === "POST" || method === "DELETE")) {
    return json(request, {
      liked: method === "POST",
      like_count: method === "POST" ? 5 : 4,
    });
  }

  const shareId = pathBetween(path, "/api/stories/", "/share");
  if (shareId && method === "POST") {
    return json(request, { shared: true, share_count: 2 });
  }

  return null;
}

async function handleActors(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (path === "/api/actors/me/blocked") {
    await readJson(request);
    return method === "GET"
      ? json(request, { blocked: [blockedSample] })
      : json(request, ok());
  }
  if (path === "/api/actors/me/muted") {
    await readJson(request);
    return method === "GET"
      ? json(request, { muted: [mutedSample] })
      : json(request, ok());
  }
  if (method === "POST" && path === "/api/actors/me/delete") {
    return json(request, ok());
  }
  if (method === "POST" && path === "/api/actors/me/move") {
    await readJson(request);
    return json(request, ok());
  }
  if (method === "POST" && path === "/api/moderation/reports/outbound") {
    await readJson(request);
    return json(request, ok());
  }
  if ((method === "PUT" || method === "PATCH") && path === "/api/actors/me") {
    const body = await readJson(request);
    me.name = typeof body.name === "string" ? body.name : me.name;
    me.summary = typeof body.summary === "string" ? body.summary : me.summary;
    if (typeof body.icon_url === "string") me.icon_url = body.icon_url;
    if (typeof body.header_url === "string") me.header_url = body.header_url;
    if (typeof body.is_private === "boolean") me.is_private = body.is_private;
    if (Array.isArray(body.fields)) {
      me.fields = (body.fields as { name: string; value: string }[]).slice(
        0,
        4,
      );
    }
    return json(request, { actor: me });
  }

  const postsId = pathBetween(path, "/api/actors/", "/posts");
  if (postsId && method === "GET") {
    const actorData = findActor(postsId);
    return json(request, {
      posts: posts.filter((post) => post.author.ap_id === actorData.ap_id),
      next_cursor: null,
      has_more: false,
    });
  }

  const followersId = pathBetween(path, "/api/actors/", "/followers");
  if (followersId && method === "GET") {
    return json(request, {
      followers: [akari, ren, mio],
      total: 3,
      has_more: false,
    });
  }

  const followingId = pathBetween(path, "/api/actors/", "/following");
  if (followingId && method === "GET") {
    return json(request, {
      following: [akari, ren],
      total: 2,
      has_more: false,
    });
  }

  const actorId = pathBetween(path, "/api/actors/");
  if (actorId && method === "GET") {
    const actorData = findActor(actorId);
    return json(request, {
      actor: actorData,
      also_known_as: actorData.also_known_as ?? [],
    });
  }
  return null;
}

async function handleSearch(
  request: Request,
  method: string,
  path: string,
  url: URL,
): Promise<Response | null> {
  if (method !== "GET") return null;
  if (path === "/api/search/hashtags/trending") {
    return json(request, {
      trending: [
        { tag: "yurucommu", count: 42 },
        { tag: "yurumeet", count: 31 },
        { tag: "mock", count: 18 },
      ],
    });
  }
  if (path === "/api/search/actors" || path === "/api/search/remote") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    return json(request, {
      actors: actors.filter((item) =>
        `${item.username} ${item.name ?? ""} ${item.summary ?? ""}`
          .toLowerCase()
          .includes(query),
      ),
      has_more: false,
    });
  }
  if (path === "/api/search/posts") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    return json(request, {
      posts: posts.filter((post) => post.content.toLowerCase().includes(query)),
      has_more: false,
    });
  }
  const hashtag = pathBetween(path, "/api/search/hashtag/");
  if (hashtag) {
    return json(request, {
      posts: posts.filter((post) =>
        post.content.toLowerCase().includes(`#${hashtag.toLowerCase()}`),
      ),
      has_more: false,
    });
  }
  return null;
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return empty(request);
  if (method === "GET" && path === "/healthz") {
    return json(request, { status: "ok", missingBindings: [] });
  }
  if (method === "GET" && path === "/.well-known/social-server") {
    return json(request, discovery(request));
  }

  const authResponse = await handleAuth(request, method, path);
  if (authResponse) return authResponse;

  const dmResponse = await handleDm(request, method, path);
  if (dmResponse) return dmResponse;

  const communityResponse = await handleCommunities(request, method, path);
  if (communityResponse) return communityResponse;

  const postResponse = await handlePosts(request, method, path);
  if (postResponse) return postResponse;

  const noteResponse = await handleNotes(request, method, path);
  if (noteResponse) return noteResponse;

  const storyResponse = await handleStories(request, method, path);
  if (storyResponse) return storyResponse;

  const actorResponse = await handleActors(request, method, path);
  if (actorResponse) return actorResponse;

  const searchResponse = await handleSearch(request, method, path, url);
  if (searchResponse) return searchResponse;

  if (path === "/api/notifications/pushers" && method === "POST") {
    const body = await readJson(request);
    const pusher =
      body.pusher && typeof body.pusher === "object"
        ? (body.pusher as Record<string, unknown>)
        : {};
    const data =
      pusher.data && typeof pusher.data === "object"
        ? (pusher.data as Record<string, JsonValue>)
        : {};
    const now = new Date().toISOString();
    return json(request, {
      pusher: {
        id: "mock-notification-pusher",
        kind: "http",
        app_id: String(pusher.app_id ?? "mock-app"),
        data,
        gateway_url: String(
          data.url ?? "https://push.example.test/_matrix/push/v1/notify",
        ),
        product: String(body.product ?? "yurume"),
        scope: typeof body.scope === "string" ? body.scope : null,
        registered_at: now,
        last_seen_at: now,
      },
    });
  }
  if (path === "/api/notifications/pushers" && method === "DELETE") {
    return json(request, { deleted: true });
  }

  if (method === "GET" && path === "/api/notifications/unread/count") {
    const count = UNREAD_NOTIF_IDS.filter(
      (id) => !readNotifications.has(id) && !archivedNotifications.has(id),
    ).length;
    return json(request, { count });
  }
  if (method === "POST" && path === "/api/notifications/archive/all") {
    let archivedCount = 0;
    for (const notification of notificationItems) {
      const id = String((notification as { id: string }).id);
      if (!archivedNotifications.has(id)) archivedCount += 1;
      archivedNotifications.add(id);
    }
    return json(request, { archived_count: archivedCount });
  }
  if (
    (method === "POST" || method === "DELETE") &&
    path === "/api/notifications/archive"
  ) {
    const body = await readJson(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    for (const id of ids) {
      if (method === "POST") archivedNotifications.add(id);
      else archivedNotifications.delete(id);
    }
    return json(request, ok());
  }
  if (method === "POST" && path === "/api/notifications/read") {
    const body = await readJson(request);
    const ids = Array.isArray(body.ids) ? body.ids : UNREAD_NOTIF_IDS;
    for (const id of ids) readNotifications.add(String(id));
    return json(request, ok());
  }
  if (method === "GET" && path === "/api/notifications") {
    return json(request, notificationsResponse(new URL(request.url)));
  }
  if (method === "GET" && path === "/api/recommendations/users") {
    return json(request, {
      users: [mio, ren].map((item, index) => ({
        ...item,
        mutual_count: index + 1,
      })),
    });
  }
  if (method === "POST" && path === "/api/media/upload") {
    return json(request, {
      url: mockImageUrl,
      r2_key: `mock/upload-${Date.now()}.jpg`,
      content_type: "image/jpeg",
    });
  }
  if (path === "/api/follow" && (method === "POST" || method === "DELETE")) {
    await readJson(request);
    return json(request, method === "POST" ? { status: "accepted" } : ok());
  }
  if (
    (path === "/api/follow/accept" || path === "/api/follow/reject") &&
    method === "POST"
  ) {
    await readJson(request);
    return json(request, ok());
  }

  return json(
    request,
    { error: `mock endpoint not implemented: ${method} ${path}` },
    { status: 404 },
  );
}

async function runSelfTest(): Promise<void> {
  const previousSignedIn = signedIn;
  signedIn = true;

  const checks: Array<[string, string, number]> = [
    ["GET", "/healthz", 200],
    ["GET", "/.well-known/social-server", 200],
    ["GET", "/api/auth/me", 200],
    ["GET", "/api/timeline", 200],
    ["GET", "/api/stories", 200],
    ["GET", "/api/dm/contacts", 200],
    ["GET", "/api/communities", 200],
    ["GET", "/api/search/hashtags/trending", 200],
  ];

  for (const [method, path, expectedStatus] of checks) {
    const response = await handleRequest(
      new Request(`http://mock.local${path}`, { method }),
    );
    if (response.status !== expectedStatus) {
      throw new Error(
        `${method} ${path} returned ${response.status}; expected ${expectedStatus}`,
      );
    }
    await response.text();
  }

  const registerResponse = await handleRequest(
    new Request("http://mock.local/api/notifications/pushers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: "yurume",
        pusher: {
          kind: "http",
          app_id: "yurume.mock",
          pushkey: "mock-pushkey",
          data: {
            url: "https://push.example.test/_matrix/push/v1/notify",
            format: "event_id_only",
          },
        },
      }),
    }),
  );
  if (registerResponse.status !== 200) {
    throw new Error(
      `POST /api/notifications/pushers returned ${registerResponse.status}; expected 200`,
    );
  }
  const registered = (await registerResponse.json()) as {
    pusher?: { product?: string; app_id?: string };
  };
  if (
    registered.pusher?.product !== "yurume" ||
    registered.pusher.app_id !== "yurume.mock"
  ) {
    throw new Error("notification pusher registration response is invalid");
  }
  const unregisterResponse = await handleRequest(
    new Request("http://mock.local/api/notifications/pushers", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: "yurume",
        app_id: "yurume.mock",
        pushkey: "mock-pushkey",
      }),
    }),
  );
  if (unregisterResponse.status !== 200) {
    throw new Error(
      `DELETE /api/notifications/pushers returned ${unregisterResponse.status}; expected 200`,
    );
  }

  const notificationResponse = await handleRequest(
    new Request("http://mock.local/api/notifications"),
  );
  const notificationBody = (await notificationResponse.json()) as {
    notifications?: Array<{ target_kind?: string; target_url?: string }>;
  };
  if (
    !notificationBody.notifications?.some(
      (notification) =>
        notification.target_kind === "story" &&
        notification.target_url?.startsWith("/?story="),
    )
  ) {
    throw new Error("story notification target is missing from mock API");
  }

  signedIn = previousSignedIn;
  console.log("dev mock self-test passed");
}

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
  } else {
    const port = Number(
      process.env.YURUCOMMU_MOCK_PORT ?? process.env.MOCK_PORT ?? "8787",
    );
    const hostname =
      process.env.YURUCOMMU_MOCK_HOST ?? process.env.MOCK_HOST ?? "0.0.0.0";
    Bun.serve({ port, hostname, fetch: handleRequest });
    console.log(`Yurucommu mock API listening on http://${hostname}:${port}`);
  }
}
