import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { workspaceRewrite } from "./lib/workspace-path";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    rewrite: workspaceRewrite(),
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
