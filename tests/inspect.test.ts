import { Effect, Schema, SchemaAST } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { Domain, node, operation, subscription } from "../src/index.ts";

const User = node(
  "User",
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
    avatar: f.field({
      type: Schema.String,
      key: (parent) => parent.id,
      resolve: (keys: ReadonlyArray<string>) =>
        Effect.succeed(new Map(keys.map((k) => [k, `https://avatars/${k}.png`]))),
    }),
  }),
);

const Post = node(
  "Post",
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    authorId: Schema.String,
  }),
  (f) => ({
    author: f.field({
      type: User,
      key: (parent) => parent.authorId,
      resolve: (keys: ReadonlyArray<string>) =>
        Effect.succeed(
          new Map(keys.map((k) => [k, { id: k, firstName: "A", lastName: "B" } as never])),
        ),
    }),
  }),
);

const Cat = node(
  "InspectCat",
  Schema.Struct({ _tag: Schema.Literal("cat"), name: Schema.String }),
  (f) => ({
    meow: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} meows`),
    }),
  }),
);

const Dog = node(
  "InspectDog",
  Schema.Struct({ _tag: Schema.Literal("dog"), name: Schema.String }),
  (f) => ({
    bark: f.field({
      type: Schema.String,
      resolve: ({ parent }) => Effect.succeed(`${parent.name} barks`),
    }),
  }),
);

describe("Unit 8: domain.inspect()", () => {
  it("reports exactly the domain operation keys with no extras or omissions", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" }),
      }),
      listPosts: operation({
        type: Schema.Array(Post),
        resolve: () => Effect.succeed([]),
      }),
      userEvents: subscription({
        type: User,
        resolve: () => {
          throw new Error("not called");
        },
      }),
    });

    const operationNames = g
      .inspect()
      .operations.map((o) => o.name)
      .sort();
    expect(operationNames).toEqual(Object.keys(g.operations).sort());
    expect(new Set(operationNames).size).toBe(operationNames.length);
  });

  it("lists operations with name, args, return type, stream flag", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        args: Schema.Struct({ id: Schema.String }),
        resolve: ({ args }) =>
          Effect.succeed({ id: args.id, firstName: "Alice", lastName: "Smith" }),
      }),
      userEvents: subscription({
        type: User,
        resolve: () => {
          throw new Error("not called");
        },
      }),
    });

    const inspection = g.inspect();
    expect(inspection.operations).toHaveLength(2);

    const getUser = inspection.operations.find((o) => o.name === "getUser")!;
    expect(getUser.stream).toBe(false);
    expect(getUser.args).not.toBeNull();
    expect(SchemaAST.isObjects(getUser.args!)).toBe(true);
    expect(getUser.returnType).toBe(User.ast);

    const userEvents = inspection.operations.find((o) => o.name === "userEvents")!;
    expect(userEvents.stream).toBe(true);
    expect(userEvents.args).toBeNull();
  });

  it("lists nodes reachable from operation return types", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" }),
      }),
      getPost: operation({
        type: Post,
        resolve: () => Effect.succeed({ id: "1", title: "T", authorId: "1" }),
      }),
    });

    const inspection = g.inspect();
    const identifiers = inspection.nodes
      .map((n) => n.identifier)
      .sort((a, b) => String(a).localeCompare(String(b)));
    expect(identifiers).toEqual(["Post", "User"]);
  });

  it("discovers nodes transitively via computed field return types", () => {
    const g = Domain.make({
      getPost: operation({
        type: Post,
        resolve: () => Effect.succeed({ id: "1", title: "T", authorId: "1" }),
      }),
    });

    const inspection = g.inspect();
    const ids = inspection.nodes
      .map((n) => n.identifier)
      .sort((a, b) => String(a).localeCompare(String(b)));
    expect(ids).toEqual(["Post", "User"]);
  });

  it("dedupes nodes that appear in multiple operations", () => {
    const g = Domain.make({
      getUserA: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" }),
      }),
      getUserB: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "2", firstName: "C", lastName: "D" }),
      }),
    });

    const inspection = g.inspect();
    expect(inspection.nodes).toHaveLength(1);
    expect(inspection.nodes[0]!.identifier).toBe("User");
  });

  it("distinguishes batched vs computed fields", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" }),
      }),
    });

    const userNode = g.inspect().nodes.find((n) => n.identifier === "User")!;
    const computedKinds = new Map(userNode.computedFields.map((c) => [c.name, c.kind]));
    expect(computedKinds.get("fullName")).toBe("computed");
    expect(computedKinds.get("avatar")).toBe("batched");
  });

  it("reports computed field args and omits args for batched fields", () => {
    const Profile = node("ProfileWithArgs", Schema.Struct({ id: Schema.String }), (f) => ({
      greeting: f.field({
        type: Schema.String,
        args: Schema.Struct({ name: Schema.String }),
        resolve: ({ args }) => Effect.succeed(`Hello ${args.name}`),
      }),
      avatar: f.field({
        type: Schema.String,
        key: (parent) => parent.id,
        resolve: (keys: ReadonlyArray<string>) =>
          Effect.succeed(new Map(keys.map((key) => [key, `avatar:${key}`]))),
      }),
    }));

    const g = Domain.make({
      getProfile: operation({
        type: Profile,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });

    const profileNode = g.inspect().nodes.find((n) => n.identifier === "ProfileWithArgs")!;
    const computed = new Map(profileNode.computedFields.map((field) => [field.name, field]));
    expect(computed.get("greeting")!.kind).toBe("computed");
    expect(computed.get("greeting")!.args).not.toBeNull();
    expect(SchemaAST.isObjects(computed.get("greeting")!.args!)).toBe(true);
    expect(computed.get("avatar")!.kind).toBe("batched");
    expect(computed.get("avatar")!.args).toBeNull();
  });

  it("exposes data fields separately from computed fields", () => {
    const g = Domain.make({
      getUser: operation({
        type: User,
        resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" }),
      }),
    });

    const userNode = g.inspect().nodes.find((n) => n.identifier === "User")!;
    const dataNames = userNode.dataFields.map((f) => f.name).sort((a, b) => a.localeCompare(b));
    expect(dataNames).toEqual(["firstName", "id", "lastName"]);

    const computedNames = userNode.computedFields
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b));
    expect(computedNames).toEqual(["avatar", "fullName"]);
  });

  it("walks into array element types for node discovery", () => {
    const g = Domain.make({
      listUsers: operation({
        type: Schema.Array(User),
        resolve: () => Effect.succeed([]),
      }),
    });

    const inspection = g.inspect();
    expect(inspection.nodes.map((n) => n.identifier)).toContain("User");
  });

  it("walks into nested array element types for node discovery", () => {
    const g = Domain.make({
      listUserGroups: operation({
        type: Schema.Array(Schema.Array(User)),
        resolve: () => Effect.succeed([]),
      }),
    });

    expect(g.inspect().nodes.map((n) => n.identifier)).toContain("User");
  });

  it("walks into union variants for node discovery", () => {
    const g = Domain.make({
      getEntity: operation({
        type: Schema.Union([User, Post]),
        resolve: () => Effect.succeed({ id: "1", firstName: "A", lastName: "B" } as never),
      }),
    });

    const ids = g.inspect().nodes.map((n) => n.identifier);
    expect(ids).toContain("User");
    expect(ids).toContain("Post");
  });

  it("walks into array-wrapped union variants for node discovery", () => {
    const g = Domain.make({
      listPetVariant: operation({
        type: Schema.Union([Schema.Array(Cat), Schema.Array(Dog)]),
        resolve: () => Effect.succeed([] as never),
      }),
    });

    const ids = g.inspect().nodes.map((n) => n.identifier);
    expect(ids).toContain("InspectCat");
    expect(ids).toContain("InspectDog");
  });
});

describe("declared error schemas", () => {
  it("exposes an operation's error AST through inspect", () => {
    const NotFound = Schema.Struct({
      _tag: Schema.Literal("NotFound"),
      id: Schema.String,
    });
    const T = node("InspectErrNode", Schema.Struct({ id: Schema.String }), {});
    const g = Domain.make({
      risky: operation({
        type: T,
        error: NotFound,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
      plain: operation({
        type: T,
        resolve: () => Effect.succeed({ id: "1" }),
      }),
    });
    const ops = new Map(g.inspect().operations.map((op) => [op.name, op]));
    expect(ops.get("risky")!.error).toBe(NotFound.ast);
    expect(ops.get("plain")!.error).toBeNull();
  });
});
