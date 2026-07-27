import { Context, Effect, Layer, Schema } from "effect";
import { Domain, node, operation } from "../src/index.ts";

interface UserRow {
  readonly id: string;
  readonly name: string;
}

interface PostRow {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
}

export interface BatchingStats {
  postBatchCalls: number;
  lastAuthorIds: ReadonlyArray<string>;
}

export class UserRepo extends Context.Service<
  UserRepo,
  {
    readonly listAll: Effect.Effect<ReadonlyArray<UserRow>>;
  }
>()("BatchingExample/UserRepo") {}

export class PostRepo extends Context.Service<
  PostRepo,
  {
    readonly findByAuthorIds: (
      authorIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<PostRow>>>;
  }
>()("BatchingExample/PostRepo") {}

const Post = node(
  "BatchingExamplePost",
  Schema.Struct({
    id: Schema.String,
    authorId: Schema.String,
    title: Schema.String,
  }),
  {},
);

const User = node(
  "BatchingExampleUser",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
  (f) => ({
    posts: f.field({
      type: Schema.Array(Post),
      key: (user: UserRow) => user.id,
      resolve: (authorIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const repo = yield* PostRepo;
          return yield* repo.findByAuthorIds(authorIds);
        }),
    }),
  }),
);

export const domain = Domain.make({
  listUsers: operation({
    type: Schema.Array(User),
    resolve: () =>
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* repo.listAll;
      }),
  }),
});

export function makeReposLive(stats: BatchingStats) {
  const users: ReadonlyArray<UserRow> = [
    { id: "u1", name: "Alice" },
    { id: "u2", name: "Bob" },
    { id: "u3", name: "Carol" },
  ];
  const posts: ReadonlyArray<PostRow> = [
    { id: "p1", authorId: "u1", title: "Post by Alice" },
    { id: "p2", authorId: "u2", title: "Post by Bob" },
    { id: "p3", authorId: "u3", title: "Post by Carol" },
  ];

  return Layer.mergeAll(
    Layer.succeed(UserRepo, {
      listAll: Effect.succeed(users),
    }),
    Layer.succeed(PostRepo, {
      findByAuthorIds: (authorIds) =>
        Effect.sync(() => {
          stats.postBatchCalls++;
          stats.lastAuthorIds = [...authorIds];

          const byAuthor = new Map<string, ReadonlyArray<PostRow>>();
          for (const authorId of authorIds) {
            byAuthor.set(
              authorId,
              posts.filter((post) => post.authorId === authorId),
            );
          }
          return byAuthor;
        }),
    }),
  );
}
