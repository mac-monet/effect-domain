import { Schema as S, pipe } from "effect";
import { Route } from "foldkit";
import { literal, r, slash, string } from "foldkit/route";

export const HomeRoute = r("Home");
export const UserRoute = r("User", { id: S.String });
export const NotFoundRoute = r("NotFound", { path: S.String });

export const AppRoute = S.Union([HomeRoute, UserRoute, NotFoundRoute]);

export type HomeRoute = typeof HomeRoute.Type;
export type UserRoute = typeof UserRoute.Type;
export type NotFoundRoute = typeof NotFoundRoute.Type;
export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(HomeRoute));
export const userRouter = pipe(literal("users"), slash(string("id")), Route.mapTo(UserRoute));

const routeParser = Route.oneOf(userRouter, homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, NotFoundRoute);
