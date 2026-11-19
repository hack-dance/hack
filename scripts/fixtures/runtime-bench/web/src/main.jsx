import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { format } from "date-fns";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { TOKEN } from "./token";

const Health = z.object({ ok: z.boolean() });
const client = new QueryClient();

function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () =>
      Health.parse(await (await fetch("/api-health")).json()),
  });
  return (
    <main>
      <h1>{TOKEN}</h1>
      <p>{format(new Date(), "yyyy-MM-dd")}</p>
      <p>{health.data?.ok ? "api ok" : "api pending"}</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </StrictMode>
  );
}
