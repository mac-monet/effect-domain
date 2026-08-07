import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Domain, node, operation, subscription } from "../../src/index.ts";

// One rich shared fixture: a blog/social graph with a User -> Post -> User
// cycle, batched fields backed by counting repos, a derived-identity Feed, a
// node without identity (KSTag), declared operation and field errors, and the
// full operation spread (query, list, mutation-like, scalar, subscription).
// All kitchen-sink projection suites import this domain.

export class KSUserNotFound extends Schema.TaggedErrorClass<KSUserNotFound>()("KSUserNotFound", {
  id: Schema.String,
  message: Schema.String,
}) {}

export class KSBioUnavailable extends Schema.TaggedErrorClass<KSBioUnavailable>()(
  "KSBioUnavailable",
  {
    userId: Schema.String,
  },
) {}

// Raw rows the repos serve. Post rows are denormalized: they already carry
// their comments, tags, and nullable editor so data fields walk for free.
export interface KSUserRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface KSCommentRow {
  readonly id: string;
  readonly body: string;
  readonly authorId: string;
}

export interface KSPostRow {
  readonly id: string;
  readonly title: string;
  readonly authorId: string;
  readonly editor: KSUserRow | null;
  readonly comments: ReadonlyArray<KSCommentRow>;
  readonly tags: ReadonlyArray<{ readonly label: string }>;
}

export interface KSStats {
  userBatchCalls: number;
  lastUserKeys: ReadonlyArray<string>;
  postBatchCalls: number;
  lastPostKeys: ReadonlyArray<string>;
}

export const makeStats = (): KSStats => ({
  userBatchCalls: 0,
  lastUserKeys: [],
  postBatchCalls: 0,
  lastPostKeys: [],
});

export class KSUserRepo extends Context.Service<
  KSUserRepo,
  {
    readonly findById: (id: string) => Effect.Effect<KSUserRow, KSUserNotFound>;
    readonly listAll: Effect.Effect<ReadonlyArray<KSUserRow>>;
    readonly findByIds: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, KSUserRow>>;
  }
>()("KitchenSink/UserRepo") {}

export class KSPostRepo extends Context.Service<
  KSPostRepo,
  {
    readonly findByAuthorIds: (
      authorIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<KSPostRow>>>;
    readonly listAll: Effect.Effect<ReadonlyArray<KSPostRow>>;
    readonly create: (title: string, authorId: string) => Effect.Effect<KSPostRow>;
  }
>()("KitchenSink/PostRepo") {}

// Type-level shapes for the suspend-broken side of the cycle. Optional
// members mirror computed fields so deep selections stay typed through the
// suspend (same pattern as the recursive Comment in tests/fields.test.ts).
export interface KSUserShape {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName?: string;
  readonly bio?: string;
  readonly posts?: ReadonlyArray<KSPostRow>;
}

const SuspendedUser = Schema.suspend((): Schema.Codec<KSUserShape> => KSUser as never);

const batchUsers = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repo = yield* KSUserRepo;
    return (yield* repo.findByIds(keys)) as ReadonlyMap<string, never>;
  });

// No identity: must never appear in read sets.
export const KSTag = node("KSTag", Schema.Struct({ label: Schema.String }), {});

export const KSComment = node(
  "KSComment",
  Schema.Struct({
    id: Schema.String,
    body: Schema.String,
    authorId: Schema.String,
  }),
  (f) => ({
    author: f.field({
      type: SuspendedUser,
      key: (comment) => comment.authorId,
      resolve: batchUsers,
    }),
  }),
  { identity: "id" },
);

export const KSPost = node(
  "KSPost",
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    authorId: Schema.String,
    editor: Schema.NullOr(SuspendedUser),
    comments: Schema.Array(KSComment),
    tags: Schema.Array(KSTag),
  }),
  (f) => ({
    author: f.field({
      type: SuspendedUser,
      key: (post) => post.authorId,
      resolve: batchUsers,
    }),
  }),
  { identity: "id" },
);

export const KSUser = node(
  "KSUser",
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.String,
    lastName: Schema.String,
  }),
  (f) => ({
    fullName: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
    bio: f.field({
      type: Schema.String,
      error: KSBioUnavailable,
      resolve: ({ parent }) =>
        parent.id === "u3"
          ? Effect.fail(new KSBioUnavailable({ userId: parent.id }))
          : Effect.succeed(`Bio of ${parent.firstName}`),
    }),
    posts: f.field({
      type: Schema.Array(KSPost),
      key: (user) => user.id,
      resolve: (authorIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const repo = yield* KSPostRepo;
          return (yield* repo.findByAuthorIds(authorIds)) as ReadonlyMap<string, never>;
        }),
    }),
  }),
  { identity: "id" },
);

export const KSFeed = node(
  "KSFeed",
  Schema.Struct({
    id: Schema.String,
    posts: Schema.Array(KSPost),
  }),
  {},
  { identity: (feed) => `feed:${feed.id}` },
);

export const domain = Domain.make({
  getUser: operation({
    type: KSUser,
    args: Schema.Struct({ id: Schema.String }),
    error: KSUserNotFound,
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const repo = yield* KSUserRepo;
        return yield* repo.findById(args.id);
      }),
  }),
  listUsers: operation({
    type: Schema.Array(KSUser),
    resolve: () =>
      Effect.gen(function* () {
        const repo = yield* KSUserRepo;
        return yield* repo.listAll;
      }),
  }),
  getFeed: operation({
    type: KSFeed,
    args: Schema.Struct({ id: Schema.String }),
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const repo = yield* KSPostRepo;
        const posts = yield* repo.listAll;
        return { id: args.id, posts };
      }),
  }),
  createPost: operation({
    type: KSPost,
    args: Schema.Struct({ title: Schema.String, authorId: Schema.String }),
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const repo = yield* KSPostRepo;
        return yield* repo.create(args.title, args.authorId);
      }),
  }),
  countUsers: operation({
    type: Schema.Number,
    resolve: () =>
      Effect.gen(function* () {
        const repo = yield* KSUserRepo;
        const users = yield* repo.listAll;
        return users.length;
      }),
  }),
  watchPosts: subscription({
    type: KSPost,
    args: Schema.Struct({ authorId: Schema.String }),
    resolve: ({ args }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const repo = yield* KSPostRepo;
          const byAuthor = yield* repo.findByAuthorIds([args.authorId]);
          return Stream.fromIterable(byAuthor.get(args.authorId) ?? []);
        }),
      ),
  }),
});

const userRows: ReadonlyArray<KSUserRow> = [
  { id: "u1", firstName: "Ada", lastName: "Lovelace" },
  { id: "u2", firstName: "Grace", lastName: "Hopper" },
  { id: "u3", firstName: "Alan", lastName: "Turing" },
];

const postRows: ReadonlyArray<KSPostRow> = [
  {
    id: "p1",
    title: "Engines",
    authorId: "u1",
    editor: userRows[1]!,
    comments: [
      { id: "c1", body: "Nice", authorId: "u2" },
      { id: "c2", body: "Agreed", authorId: "u3" },
    ],
    tags: [{ label: "math" }],
  },
  {
    id: "p2",
    title: "Compilers",
    authorId: "u2",
    editor: null,
    comments: [{ id: "c3", body: "Classic", authorId: "u1" }],
    tags: [{ label: "systems" }],
  },
  {
    id: "p3",
    title: "Machines",
    authorId: "u1",
    editor: null,
    comments: [],
    tags: [],
  },
];

export function makeLive(stats: KSStats = makeStats()) {
  const posts = [...postRows];
  let nextId = 100;
  return Layer.mergeAll(
    Layer.succeed(KSUserRepo, {
      findById: (id) => {
        const user = userRows.find((u) => u.id === id);
        return user
          ? Effect.succeed(user)
          : Effect.fail(new KSUserNotFound({ id, message: `User ${id} not found` }));
      },
      listAll: Effect.succeed(userRows),
      findByIds: (ids) =>
        Effect.sync(() => {
          stats.userBatchCalls++;
          stats.lastUserKeys = [...ids];
          return new Map(
            ids.flatMap((id) => {
              const user = userRows.find((u) => u.id === id);
              return user ? [[id, user] as const] : [];
            }),
          );
        }),
    }),
    Layer.succeed(KSPostRepo, {
      findByAuthorIds: (authorIds) =>
        Effect.sync(() => {
          stats.postBatchCalls++;
          stats.lastPostKeys = [...authorIds];
          return new Map(
            authorIds.map((authorId) => [authorId, posts.filter((p) => p.authorId === authorId)]),
          );
        }),
      listAll: Effect.sync(() => posts),
      create: (title, authorId) =>
        Effect.sync(() => {
          const row: KSPostRow = {
            id: `p${nextId++}`,
            title,
            authorId,
            editor: null,
            comments: [],
            tags: [],
          };
          posts.push(row);
          return row;
        }),
    }),
  );
}
