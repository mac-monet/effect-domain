import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Domain, node, operation, subscription } from "../src/index.ts";

// Soundness pattern: services live in resolvers, never in args schemas.
// `OperationDef.args` is typed `Schema.Decoder<Args>` — DecodingServices = never —
// so the gateway can decode args without provisioning anything beyond what
// the transport itself needs. Authorization, lookups, and side-effecting
// validation belong inside `resolve`, where the Effect channel tracks the
// requirement (`R`). This keeps the boundary's R independent of args
// validation and prevents silently dropped service requirements.

interface UserRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly profile: {
    readonly bio: string;
    readonly location: string;
  };
}

export class UserRepo extends Context.Service<
  UserRepo,
  {
    readonly findById: (id: string) => Effect.Effect<UserRow, UserNotFound>;
    readonly listAll: Effect.Effect<ReadonlyArray<UserRow>>;
    readonly create: (firstName: string, lastName: string) => Effect.Effect<UserRow>;
  }
>()("UserRepo") {}

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()("UserNotFound", {
  id: Schema.String,
  message: Schema.String,
}) {}

export const Profile = node(
  "Profile",
  Schema.Struct({
    bio: Schema.String,
    location: Schema.String,
  }),
  {},
);

export const User = node(
  "User",
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.String,
    lastName: Schema.String,
    profile: Profile,
  }),
  (f) => ({
    fullName: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.firstName} ${parent.lastName}`),
    }),
    greeting: f.field({
      type: Schema.String,
      args: Schema.Struct({ salutation: Schema.String }),
      resolve: ({ parent, args }) =>
        Effect.succeed(`${args.salutation} ${parent.firstName} ${parent.lastName}`),
    }),
  }),
);

export const domain = Domain.make({
  getUser: operation({
    type: User,
    args: Schema.Struct({ id: Schema.String }),
    error: UserNotFound,
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* repo.findById(args.id);
      }),
  }),
  listUsers: operation({
    type: Schema.Array(User),
    resolve: () =>
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* repo.listAll;
      }),
  }),
  createUser: operation({
    type: User,
    args: Schema.Struct({
      firstName: Schema.String,
      lastName: Schema.String,
    }),
    resolve: ({ args }) =>
      Effect.gen(function* () {
        const repo = yield* UserRepo;
        return yield* repo.create(args.firstName, args.lastName);
      }),
  }),
  watchUsers: subscription({
    type: User,
    args: Schema.Struct({ start: Schema.Number }),
    resolve: ({ args }) =>
      Stream.make(
        {
          id: String(args.start),
          firstName: "Stream",
          lastName: "One",
          profile: {
            bio: "First streamed user",
            location: "Stream",
          },
        },
        {
          id: String(args.start + 1),
          firstName: "Stream",
          lastName: "Two",
          profile: {
            bio: "Second streamed user",
            location: "Stream",
          },
        },
      ),
  }),
});

export const UserRepoLive = Layer.sync(UserRepo)(() => {
  const data = new Map<string, UserRow>([
    [
      "1",
      {
        id: "1",
        firstName: "Alice",
        lastName: "Anderson",
        profile: {
          bio: "Maintains the domain gateway",
          location: "Taipei",
        },
      },
    ],
    [
      "2",
      {
        id: "2",
        firstName: "Bob",
        lastName: "Brown",
        profile: {
          bio: "Builds transport adapters",
          location: "San Francisco",
        },
      },
    ],
  ]);
  let nextId = 3;
  return {
    findById: (id) =>
      data.has(id)
        ? Effect.succeed(data.get(id) as UserRow)
        : Effect.fail(new UserNotFound({ id, message: `User ${id} not found` })),
    listAll: Effect.sync(() => Array.from(data.values())),
    create: (firstName, lastName) =>
      Effect.sync(() => {
        const id = String(nextId++);
        const row: UserRow = {
          id,
          firstName,
          lastName,
          profile: {
            bio: `${firstName} ${lastName} just joined`,
            location: "Unknown",
          },
        };
        data.set(id, row);
        return row;
      }),
  };
});
